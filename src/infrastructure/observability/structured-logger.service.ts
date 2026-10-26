import { Injectable } from "@nestjs/common";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

const REDACTED_KEYS = new Set([
  "authorization",
  "password",
  "token",
  "secret",
  "clientsecret",
  "apikey",
  "cookie",
]);

@Injectable()
export class StructuredLoggerService {
  info(message: string, ctx: LogContext = {}) {
    this.emit("INFO", message, ctx);
  }

  warn(message: string, ctx: LogContext = {}) {
    this.emit("WARN", message, ctx);
  }

  error(message: string, ctx: LogContext = {}) {
    this.emit("ERROR", message, ctx);
  }

  private emit(level: string, message: string, ctx: LogContext) {
    if (process.env.SILENT_LOGS === "true") return;
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx)) {
      if (!REDACTED_KEYS.has(k.toLowerCase())) {
        sanitized[k] = v;
      }
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      instanceId: process.env.INSTANCE_ID ?? "local",
      message,
      ...sanitized,
    };

    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}
