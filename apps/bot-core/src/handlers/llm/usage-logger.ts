import { Injectable } from '@nestjs/common';
import { createPool, Pool } from 'mysql2/promise';
import { ConfigService } from '../../common/config/config.service';
import { ChatUsage } from './llm.types';

@Injectable()
export class UsageLogger {
  private pool: Pool | null = null;

  constructor(private readonly cfg: ConfigService) {}

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = createPool({
        host: this.cfg.mysqlHost,
        port: this.cfg.mysqlPort,
        user: this.cfg.mysqlUser,
        password: this.cfg.mysqlPassword,
        database: this.cfg.mysqlDatabase,
        connectionLimit: 5,
      });
    }
    return this.pool;
  }

  async record(args: {
    userId?: string;
    provider: string;
    model: string;
    usage: ChatUsage;
    costUsd?: number;
  }): Promise<void> {
    await this.getPool().query(
      `INSERT INTO usage_log (user_id, provider, model, prompt_tokens, completion_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        args.userId ? Number(args.userId) : null,
        args.provider,
        args.model,
        args.usage.promptTokens,
        args.usage.completionTokens,
        args.costUsd ?? null,
      ],
    );
  }
}