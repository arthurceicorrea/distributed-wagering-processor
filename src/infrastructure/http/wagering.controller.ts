import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { ProcessWagerTransactionUseCase } from "../../application/process-wager-transaction.use-case";
import { QueriesUseCase } from "../../application/queries.use-case";
import { InvalidInputContractError } from "../../domain/errors";
import { MoneyProps } from "../../domain/money";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { ProviderAuthGuard } from "../auth/provider-auth.guard";

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly queriesUseCase: QueriesUseCase,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body()
    body: {
      providerId: string;
      externalTransactionId: string;
      playerId: string;
      walletId: string;
      roundId: string;
      gameId: string;
      kind: WagerTransactionKind;
      money: MoneyProps;
      referenceExternalTransactionId?: string;
    },
    @Res() res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      throw new InvalidInputContractError("Header 'Idempotency-Key' is mandatory");
    }

    const result = await this.processWagerUseCase.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId,
    });

    let httpStatus = HttpStatus.OK;
    if (result.status === WagerTransactionStatus.PendingReference) {
      httpStatus = HttpStatus.ACCEPTED;
    } else if (result.status === WagerTransactionStatus.Rejected) {
      httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
    }

    return res.status(httpStatus).json(result);
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    return await this.queriesUseCase.getTransactionById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProviderExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return await this.queriesUseCase.getTransactionByProviderExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
