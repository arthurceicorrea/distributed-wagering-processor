import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { PROVIDER_IDENTITY_PORT } from "./application/ports";
import { ProcessWagerTransactionUseCase } from "./application/process-wager-transaction.use-case";
import { QueriesUseCase } from "./application/queries.use-case";
import { ReconcileWalletUseCase } from "./application/reconcile-wallet.use-case";
import {
  OidcProviderIdentityAdapter,
  ProviderAuthGuard,
} from "./infrastructure/auth/provider-auth.guard";
import mikroOrmConfig from "./infrastructure/config/mikro-orm.config";
import { HealthController } from "./infrastructure/http/health.controller";
import { WageringController } from "./infrastructure/http/wagering.controller";
import { WalletsController } from "./infrastructure/http/wallets.controller";
import { OutboxPublisherWorker } from "./infrastructure/messaging/outbox-publisher.worker";
import { PendingReferenceWorker } from "./infrastructure/messaging/pending-reference.worker";
import { SqsWagerConsumer } from "./infrastructure/messaging/sqs-wager.consumer";
import { SqsClientProvider } from "./infrastructure/messaging/sqs.client";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "./infrastructure/observability/structured-logger.service";

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    StructuredLoggerService,
    MetricsService,
    SqsClientProvider,
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: OidcProviderIdentityAdapter,
    },
    ProviderAuthGuard,
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    QueriesUseCase,
    SqsWagerConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
  ],
})
export class AppModule {}
