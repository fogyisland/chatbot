import { Controller, Get, OnModuleDestroy, OnModuleInit, Param, Post, Query, UseGuards } from '@nestjs/common';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';
import { ConfigService } from '../common/config/config.service';
import { AdminGuard } from './admin.guard';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController implements OnModuleInit, OnModuleDestroy {
  private pool!: Pool;

  constructor(private readonly cfg: ConfigService) {}

  onModuleInit(): void {
    this.pool = createPool({
      host: this.cfg.mysqlHost,
      port: this.cfg.mysqlPort,
      user: this.cfg.mysqlUser,
      password: this.cfg.mysqlPassword,
      database: this.cfg.mysqlDatabase,
      connectionLimit: 5,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  @Get('messages')
  async messages(
    @Query('platform') platform?: string,
    @Query('chat_id') chatId?: string,
    @Query('limit') limit = '50',
  ) {
    const lim = Math.min(Number(limit) || 50, 500);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (platform) { where.push('platform = ?'); params.push(platform); }
    if (chatId)   { where.push('chat_id = ?'); params.push(chatId); }
    const sql = `SELECT id, msg_id, platform, chat_id, sender_id, role, LEFT(content, 500) AS preview, created_at
                 FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    params.push(lim);
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows;
  }

  @Get('dlq')
  async dlq() {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT job_id, payload_json, error_message, retries, created_at
       FROM dlq_records ORDER BY created_at DESC LIMIT 100`,
    );
    return rows;
  }

  @Get('usage')
  async usage(@Query('days') days = '7') {
    const d = Math.min(Number(days) || 7, 90);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT provider, model,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(cost_usd) AS total_cost
       FROM usage_log
       WHERE created_at >= NOW() - INTERVAL ? DAY
       GROUP BY provider, model`,
      [d],
    );
    return rows;
  }

  @Post('dlq/:jobId/replay')
  async replay(@Param('jobId') jobId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT payload_json FROM dlq_records WHERE job_id = ?`,
      [jobId],
    );
    if (rows.length === 0) return { ok: false, error: 'not_found' };
    // Real impl: re-enqueue to BullMQ. MVP returns confirmation only.
    return { ok: true, replayed: jobId };
  }
}