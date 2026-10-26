import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { OutboxMessage } from "../../domain/outbox-message";
import { MetricsService } from "../observability/metrics.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { SqsClientProvider } from "./sqs.client";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: string;
  attempts: number;
  next_attempt_at: string | null;
  published_at: string | null;
}

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private isProcessing = false;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsClientProvider,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit() {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") return;
    this.timer = setInterval(() => {
      void this.publishPendingBatch();
    }, 300);
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    while (this.isProcessing) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async publishPendingBatch(batchSize: number = 25): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;
    let publishedCount = 0;

    try {
      const fork = this.em.fork();
      await fork.transactional(async (txEm) => {
        const now = new Date();
        const rows = await txEm.getConnection().execute<OutboxRow[]>(
          `
          SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
          FROM outbox_messages
          WHERE published_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY occurred_at ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED
          `,
          [now.toISOString(), batchSize],
        );

        if (rows.length === 0) return;

        const groups = new Map<string, OutboxMessage[]>();
        for (const row of rows) {
          const domainMsg = OutboxMessage.rehydrate({
            id: row.id,
            aggregateId: row.aggregate_id,
            eventType: row.event_type,
            payload:
              typeof row.payload === "string"
                ? JSON.parse(row.payload)
                : row.payload,
            occurredAt: new Date(row.occurred_at),
            attempts: Number(row.attempts),
            nextAttemptAt: row.next_attempt_at
              ? new Date(row.next_attempt_at)
              : undefined,
            publishedAt: row.published_at
              ? new Date(row.published_at)
              : undefined,
          });
          const list = groups.get(domainMsg.aggregateId) ?? [];
          list.push(domainMsg);
          groups.set(domainMsg.aggregateId, list);
        }

        const publishedIds: string[] = [];
        let latestPublishedAt = new Date();

        await Promise.all(
          Array.from(groups.values()).map(async (groupMessages) => {
            for (const domainMsg of groupMessages) {
              try {
                await this.sqs.client.send(
                  new SendMessageCommand({
                    QueueUrl: this.sqs.eventsQueueUrl,
                    MessageBody: JSON.stringify(domainMsg.payload),
                    MessageGroupId: domainMsg.aggregateId,
                    MessageDeduplicationId: domainMsg.id,
                  }),
                );

                const publishedAt = new Date();
                latestPublishedAt = publishedAt;
                domainMsg.markPublished(publishedAt);
                publishedIds.push(domainMsg.id);
                publishedCount += 1;

                const lagMs =
                  publishedAt.getTime() - domainMsg.occurredAt.getTime();
                this.metrics.setOutboxLagMs(Math.max(0, lagMs));
              } catch (pubErr: unknown) {
                domainMsg.scheduleRetry(new Date());
                this.metrics.incrementRetries();
                await txEm.getConnection().execute(
                  `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ?`,
                  [
                    domainMsg.attempts,
                    domainMsg.nextAttemptAt!.toISOString(),
                    domainMsg.id,
                  ],
                );
                this.logger.warn("Outbox publish failed, scheduled retry", {
                  eventId: domainMsg.id,
                  attempts: domainMsg.attempts,
                });
                break;
              }
            }
          }),
        );

        if (publishedIds.length > 0) {
          const placeholders = publishedIds.map(() => "?").join(", ");
          await txEm.getConnection().execute(
            `UPDATE outbox_messages SET published_at = ? WHERE id IN (${placeholders})`,
            [latestPublishedAt.toISOString(), ...publishedIds],
          );
        }
      });
    } finally {
      this.isProcessing = false;
    }

    return publishedCount;
  }
}
