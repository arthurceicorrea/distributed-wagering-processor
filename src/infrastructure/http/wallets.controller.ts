import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Headers,
  UseGuards,
} from "@nestjs/common";
import { CreateWalletUseCase } from "../../application/create-wallet.use-case";
import { QueriesUseCase } from "../../application/queries.use-case";
import { ReconcileWalletUseCase } from "../../application/reconcile-wallet.use-case";
import { MoneyProps } from "../../domain/money";
import { ProviderAuthGuard } from "../auth/provider-auth.guard";

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    private readonly queriesUseCase: QueriesUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(
    @Body() body: { playerId: string; initialBalance: MoneyProps },
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return await this.createWalletUseCase.execute({
      playerId: body?.playerId,
      initialBalance: body?.initialBalance,
      correlationId,
    });
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string) {
    return await this.queriesUseCase.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return await this.queriesUseCase.getWalletLedger(
      walletId,
      cursor,
      limit ? Number(limit) : 50,
    );
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param("walletId") walletId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return await this.reconcileWalletUseCase.execute(walletId, correlationId);
  }
}
