import { SQSClient } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";

@Injectable()
export class SqsClientProvider {
  public readonly client: SQSClient;
  public readonly wagerQueueUrl: string;
  public readonly wagerDlqUrl: string;
  public readonly eventsQueueUrl: string;

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });

    const base =
      process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
    this.wagerQueueUrl =
      process.env.SQS_WAGER_QUEUE_URL ??
      `${base}/000000000000/wager-transactions.fifo`;
    this.wagerDlqUrl =
      process.env.SQS_WAGER_DLQ_URL ??
      `${base}/000000000000/wager-transactions-dlq.fifo`;
    this.eventsQueueUrl =
      process.env.SQS_EVENTS_QUEUE_URL ??
      `${base}/000000000000/integration-events.fifo`;
  }
}
