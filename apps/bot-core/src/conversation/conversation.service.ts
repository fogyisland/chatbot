import { Injectable, Logger } from '@nestjs/common';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';
import { PlatformName, estimateTokens } from '@mpcb/shared';
import { ConfigService } from '../common/config/config.service';

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LoadHistoryOptions {
  tokenBudget?: number;
}

@Injectable()
export class ConversationService {
  private static readonly HISTORY_LIMIT = 10;
  private static readonly FETCH_LIMIT = 20;
  private static readonly SESSION_IDLE_MS = 30 * 60 * 1000;
  private static readonly BOUNDARY_CONTENT = '__forget_boundary__';

  private readonly logger = new Logger(ConversationService.name);
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

  async loadHistory(
    platform: PlatformName,
    chatId: string,
    senderId: string,
    now: number,
    options?: LoadHistoryOptions,
  ): Promise<ConversationTurn[]> {
    let rows: Array<{ role: 'user' | 'assistant' | 'system'; content: string; created_at: Date }>;
    try {
      const [result] = await this.getPool().query<RowDataPacket[]>(
        `SELECT role, content, created_at FROM messages
         WHERE platform = ? AND chat_id = ? AND sender_id IN (?, ?)
         ORDER BY created_at DESC
         LIMIT ?`,
        [platform, chatId, senderId, 'bot', ConversationService.FETCH_LIMIT],
      );
      rows = result as Array<{ role: 'user' | 'assistant' | 'system'; content: string; created_at: Date }>;
    } catch (err) {
      this.logger.warn(`conversation history load failed; degrading to single-turn: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    if (rows.length === 0) return [];

    const surviving: ConversationTurn[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Soft /forget boundary: walker stops here. Boundary at i=0 means
      // the user's most-recent activity is a forget → empty history.
      if (row.role === 'system' && row.content === ConversationService.BOUNDARY_CONTENT) break;
      const ts = new Date(row.created_at).getTime();
      if (i === 0) {
        if (ts < now - ConversationService.SESSION_IDLE_MS) break;
      } else {
        const prevTs = new Date(rows[i - 1].created_at).getTime();
        if (ts < prevTs - ConversationService.SESSION_IDLE_MS) break;
      }
      surviving.push({ role: row.role, content: row.content });
      if (surviving.length >= ConversationService.HISTORY_LIMIT) break;
    }

    surviving.reverse();

    if (options?.tokenBudget === undefined || options.tokenBudget <= 0) {
      return surviving;
    }

    const enriched = surviving.map(t => ({
      ...t,
      tokens: estimateTokens(t.content),
    }));
    let total = enriched.reduce((s, t) => s + t.tokens, 0);
    let keepFrom = 0;
    while (keepFrom < enriched.length - 1 && total >= options.tokenBudget) {
      total -= enriched[keepFrom].tokens;
      keepFrom++;
    }
    const trimmed = enriched.slice(keepFrom);
    if (keepFrom > 0) {
      this.logger.debug(
        `history trimmed: dropped ${keepFrom}/${enriched.length} turns (budget=${options.tokenBudget})`,
      );
    }
    return trimmed.map(({ tokens: _tokens, ...t }) => t);
  }
}
