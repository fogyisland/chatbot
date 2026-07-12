import { Injectable, Logger } from '@nestjs/common';
import { createPool, Pool } from 'mysql2/promise';
import { ConfigService } from '../common/config/config.service';
import { NormalizedMessage, NormalizedReply } from '@mpcb/shared';
import * as crypto from 'crypto';

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
  private static readonly FORGET_BOUNDARY_CONTENT = '__forget_boundary__';
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

  /**
   * Write a soft-boundary row into the messages table so the ConversationService
   * walker breaks at this point. Uses role='system' + content='__forget_boundary__'
   * as the sentinel. Idempotent on msg_id via ON DUPLICATE KEY UPDATE.
   *
   * Unlike upsertUser/upsertAssistant, this PROPAGATES errors — callers
   * (MessageProcessor) need to know whether the boundary was actually written.
   */
  async upsertForgetBoundary(msg: NormalizedMessage): Promise<void> {
    if (!msg.msgId) return;
    await this.getPool().query(
      `INSERT INTO messages (msg_id, platform, chat_id, sender_id, role, content)
       VALUES (?, ?, ?, ?, 'system', ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [msg.msgId, msg.platform, msg.chatId, msg.senderId, MessageLogService.FORGET_BOUNDARY_CONTENT],
    );
  }

  /**
   * v0.6: write a summary row to messages, idempotent on a deterministic
   * sessionKey-derived msg_id. Subsequent calls with the same sessionKey
   * UPDATE the same row (incremental merge — not a new row).
   *
   * Error propagation parallels upsertForgetBoundary — the caller
   * (ConversationService.loadOrBuildHistory) decides whether to degrade.
   */
  async upsertSummary(
    content: string,
    platform: string,
    chatId: string,
    senderId: string,
  ): Promise<void> {
    const sessionKey = `${platform}::${chatId}::${senderId}`;
    const msgId = `summary-${crypto.createHash('sha1').update(sessionKey).digest('hex').slice(0, 16)}`;
    await this.getPool().query(
      `INSERT INTO messages (msg_id, platform, chat_id, sender_id, role, content)
       VALUES (?, ?, ?, ?, 'summary', ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [msgId, platform, chatId, senderId, content],
    );
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
