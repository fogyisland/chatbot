import { Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { TeamsAdapter } from './teams.adapter';
import { QueueService } from '../../queue/queue.service';
import { MessageLogService } from '../../messages/message-log.service';

@Controller('bot/teams')
export class TeamsController {
  constructor(
    private readonly adapter: TeamsAdapter,
    private readonly queue: QueueService,
    private readonly messageLog: MessageLogService,
  ) {}

  @Post('messages')
  async messages(@Req() req: Request) {
    if (!this.adapter.verifySignature({ headers: req.headers as any, body: req.body, query: req.query as any })) {
      return { status: 401 };
    }
    const msg = await this.adapter.parseInbound({ headers: req.headers as any, body: req.body, query: req.query as any });
    if (!msg.msgId || !msg.text) return { status: 200 };
    await this.messageLog.upsertUser(msg);
    await this.queue.enqueueMessage(msg);
    return { status: 202 };
  }
}