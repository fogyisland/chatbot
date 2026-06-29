import { Controller, Post, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { WeChatAdapter } from './wechat.adapter';
import { QueueService } from '../../queue/queue.service';

@Controller('bot/wechat')
export class WeChatController {
  constructor(
    private readonly adapter: WeChatAdapter,
    private readonly queue: QueueService,
  ) {}

  @Post('callback')
  async callback(@Req() req: Request) {
    if (!this.adapter.verifySignature({ headers: req.headers as any, body: req.body, query: req.query as any })) {
      throw new BadRequestException('invalid signature');
    }
    const msg = await this.adapter.parseInbound({ headers: req.headers as any, body: req.body, query: req.query as any });
    if (!msg.msgId || !msg.text) return 'success';
    await this.queue.enqueueMessage(msg);
    return 'success';
  }
}