import { Injectable, Logger } from '@nestjs/common';
import { createPool, Pool } from 'mysql2/promise';
import { ConfigService } from '../common/config/config.service';
import { NormalizedMessage, NormalizedReply } from '@mpcb/shared';

/**
 * Persists inbound user messages and outbound assistant replies to the
 * `messages` table using INSERT … ON DUPLICATE KEY UPDATE on
 * (platform, msg_id). This is the write side of the admin Messages page.
 *
 * For assistant upserts, callers should provide the assistant message id
 * (derived from the inbound msgId) so retries / replays don't duplicate
 * rows. If `assistantMsgId` is omitted, a synthetic id is generated.
 */
@Injectable()
export class MessageLogService {
  private readonly logger = new Logger(MessageLogService.name);
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

  async upsertUser(msg: NormalizedMessage): Promise<void> {
    if (!msg.msgId) return;
    try {
      await this.getPool().query(
        `INSERT INTO messages (msg_id, platform, chat_id, sender_id, role, content)
         VALUES (?, ?, ?, ?, 'user', ?)
         ON DUPLICATE KEY UPDATE
           chat_id = VALUES(chat_id),
           sender_id = VALUES(sender_id),
           content = VALUES(content)`,
        [msg.msgId, msg.platform, msg.chatId, msg.senderId, msg.text ?? ''],
      );
    } catch (err) {
      this.logger.warn(`upsertUser failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async upsertAssistant(reply: NormalizedReply, inboundMsgId: string, platform: string, chatId: string): Promise<void> {
    const assistantMsgId = `reply-${inboundMsgId}`;
    const content = reply.text ?? '';
    try {
      await this.getPool().query(
        `INSERT INTO messages (msg_id, platform, chat_id, sender_id, role, content)
         VALUES (?, ?, ?, ?, 'assistant', ?)
         ON DUPLICATE KEY UPDATE
           chat_id = VALUES(chat_id),
           content = VALUES(content)`,
        [assistantMsgId, platform, chatId, 'bot', content],
      );
    } catch (err) {
      this.logger.warn(`upsertAssistant failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}