import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  PlatformName,
  NormalizedMessage,
  NormalizedReply,
  ChatTarget,
  MediaType,
  MediaRef,
} from '@mpcb/shared';
import {
  PlatformAdapter,
  RawRequest,
  SendResult,
} from '../platform-adapter.interface';

@Injectable()
export class DingTalkAdapter implements PlatformAdapter {
  readonly platform: PlatformName = 'dingtalk';
  private readonly logger = new Logger(DingTalkAdapter.name);

  constructor(private readonly options: { appKey: string; appSecret: string }) {}

  verifySignature(req: RawRequest): boolean {
    const ts = String(req.query?.timestamp ?? '');
    const sign = String(req.query?.sign ?? '');
    if (!ts || !sign) return false;
    const stringToSign = `${ts}\n${this.options.appSecret}`;
    const computed = createHmac('sha256', this.options.appSecret)
      .update(stringToSign)
      .digest('base64');
    return computed === sign;
  }

  async parseInbound(req: RawRequest): Promise<NormalizedMessage> {
    const b = (req.body ?? {}) as any;
    const textObj = b.text ?? {};
    return {
      msgId: String(b.msgId ?? ''),
      platform: 'dingtalk',
      chatId: String(b.conversationId ?? ''),
      chatType: b.conversationType === '1' ? 'direct' : 'group',
      senderId: String(b.senderId ?? ''),
      senderName: String(b.senderNick ?? 'unknown'),
      text: String(textObj.content ?? ''),
      mentions: [],
      attachments: [],
      rawTimestamp: Date.now(),
    };
  }

  async sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult> {
    if (!reply.text) return { ok: true };
    // Real implementation calls oToMessages/bot POST endpoints with sessionWebhook.
    this.logger.log(`[dingtalk] → ${target.chatId}: ${reply.text}`);
    return { ok: true, platformMessageId: `ding-${Date.now()}` };
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}
