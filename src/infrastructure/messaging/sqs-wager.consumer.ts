import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../../application/process-wager-transaction.use-case";
import {
  CurrencyMismatchError,
  EntityNotFoundError,
  IdempotencyConflictError,
  InvalidInputContractError,
  InvalidMoneyError,
} from "../../domain/errors";
import { MetricsService } from "../observability/metrics.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { SqsClientProvider } from "./sqs.client";
import { MoneyProps } from "../../domain/money";
import { WagerTransactionKind } from "../../domain/wager-transaction";

export const WAGER_CONSUMER_NAME = "sqs-wager-transactions-consumer";
const MAX_RECEIVES_BEFORE_DLQ = 5;

interface WagerMessageData {
  idempotencyKey?: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

interface WagerMessageEnvelope {
  messageId: string;
  data: WagerMessageData;
}

@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnApplicationShutdown {
  private running = false;
  private inFlightPromise: Promise<void> | null = null;

  constructor(
    private readonly sqs: SqsClientProvider,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") return;
    this.running = true;
    this.pollLoop();
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.info("Shutting down SqsWagerConsumer gracefully", { signal });
    this.running = false;
    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.sqs.wagerQueueUrl,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 1,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
        );

        if (response.Messages && response.Messages.length > 0) {
          for (const msg of response.Messages) {
            if (!this.running) {
              if (msg.ReceiptHandle) {
                await this.sqs.client.send(
                  new ChangeMessageVisibilityCommand({
                    QueueUrl: this.sqs.wagerQueueUrl,
                    ReceiptHandle: msg.ReceiptHandle,
                    VisibilityTimeout: 0,
                  }),
                );
              }
              continue;
            }
            this.inFlightPromise = this.handleSingleMessage(msg);
            await this.inFlightPromise;
            this.inFlightPromise = null;
          }
        }
      } catch (err: unknown) {
        if (this.running) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }

  async handleSingleMessage(msg: Message): Promise<void> {
    if (!msg.Body || !msg.ReceiptHandle) return;
    const receiveCount = Number(
      msg.Attributes?.ApproximateReceiveCount ?? "1",
    );

    let parsed: WagerMessageEnvelope;
    try {
      const candidate: unknown = JSON.parse(msg.Body);
      if (!isWagerMessageEnvelope(candidate)) {
        throw new InvalidInputContractError("Malformed SQS message envelope");
      }
      parsed = candidate;
    } catch {
      await this.moveToDlq(msg, "MALFORMED_JSON_OR_ENVELOPE");
      return;
    }

    const messageId: string = parsed.messageId;
    const data = parsed.data;

    try {
      await this.processWagerUseCase.execute({
        idempotencyKey:
          data.idempotencyKey ??
          `${data.providerId}:${data.externalTransactionId}`,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId: messageId,
        inboxContext: {
          messageId,
          consumerName: WAGER_CONSUMER_NAME,
        },
      });
    } catch (err: unknown) {
      const isPermanentError =
        err instanceof InvalidMoneyError ||
        err instanceof InvalidInputContractError ||
        err instanceof IdempotencyConflictError ||
        err instanceof CurrencyMismatchError ||
        err instanceof EntityNotFoundError;

      if (isPermanentError || receiveCount >= MAX_RECEIVES_BEFORE_DLQ) {
        await this.moveToDlq(
          msg,
          getErrorCode(err) ?? "MAX_RETRIES_OR_PERMANENT_ERROR",
        );
        return;
      }

      this.metrics.incrementRetries();
      const backoffSeconds = Math.min(30, Math.pow(2, receiveCount));
      await this.sqs.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.sqs.wagerQueueUrl,
          ReceiptHandle: msg.ReceiptHandle,
          VisibilityTimeout: backoffSeconds,
        }),
      );
      return;
    }

    await this.sqs.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.sqs.wagerQueueUrl,
        ReceiptHandle: msg.ReceiptHandle,
      }),
    );
  }

  private async moveToDlq(msg: Message, reason: string): Promise<void> {
    this.metrics.incrementDlqMessages();
    this.logger.error("Moving message to DLQ", {
      messageId: msg.MessageId,
      reason,
    });

    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: this.sqs.wagerDlqUrl,
        MessageBody: msg.Body!,
        MessageGroupId: "dlq-group",
        MessageDeduplicationId: `${msg.MessageId ?? crypto.randomUUID()}-${Date.now()}`,
      }),
    );

    if (msg.ReceiptHandle) {
      await this.sqs.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.sqs.wagerQueueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
    }
  }

}

function isWagerMessageEnvelope(value: unknown): value is WagerMessageEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { messageId?: unknown; data?: unknown };
  return (
    typeof candidate.messageId === "string" &&
    typeof candidate.data === "object" &&
    candidate.data !== null
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
