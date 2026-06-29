import { Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { DingTalkAdapter } from './dingtalk.adapter';
import { QueueService } from '../../queue/queue.service';

@Controller('bot/dingtalk')
export class DingTalkController {
  constructor(
    private readonly adapter: DingTalkAdapter,
    private readonly queue: QueueService,
  ) {}

  @Post('stream')
  async stream(@Req() req: Request) {
    if (!this.adapter.verifySignature({ headers: req.headers as any, body: req.body, query: req.query as any })) {
      return { errcode: 401 };
    }
    const msg = await this.adapter.parseInbound({ headers: req.headers as any, body: req.body, query: req.query as any });
    if (!msg.msgId || !msg.text) return { errcode: 0 };
    await this.queue.enqueueMessage(msg);
    return { errcode: 0 };
  }
}