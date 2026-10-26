import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { SqsClientProvider } from "../messaging/sqs.client";
import { MetricsService } from "../observability/metrics.service";

@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsClientProvider,
    private readonly metrics: MetricsService,
  ) {}

  @Get("health/live")
  live() {
    return { status: "UP", timestamp: new Date().toISOString() };
  }

  @Get("health/ready")
  async ready(@Res() res: Response) {
    try {
      await this.em.getConnection().execute("SELECT 1");
      await this.sqs.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.sqs.wagerQueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      return res.status(HttpStatus.OK).json({
        status: "READY",
        dependencies: { postgres: "UP", sqs: "UP" },
      });
    } catch (err: unknown) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: "NOT_READY",
        error: err instanceof Error ? err.message : "Dependency check failed",
      });
    }
  }

  @Get("metrics")
  getMetrics() {
    return this.metrics.snapshot();
  }
}
