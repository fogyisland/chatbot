import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
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
export class WeChatAdapter implements PlatformAdapter {
  readonly platform: PlatformName = 'wechat';
  private readonly logger = new Logger(WeChatAdapter.name);

  constructor(private readonly token: string) {}

  verifySignature(req: RawRequest): boolean {
    const signature = String(req.query.msg_signature ?? '');
    const timestamp = String(req.query.timestamp ?? '');
    const nonce = String(req.query.nonce ?? '');
    const encrypt = String(req.query.encrypt ?? '');
    if (!signature || !timestamp || !nonce || !encrypt) return false;
    const sorted = [timestamp, nonce, encrypt].sort().join('');
    const computed = createHash('sha1').update(sorted + this.token).digest('hex');
    return computed === signature;
  }

  async parseInbound(req: RawRequest): Promise<NormalizedMessage> {
    const body = req.body as any;
    const inner = body?.xml ?? {};
    return {
      msgId: String(inner.MsgId ?? ''),
      platform: 'wechat',
      chatId: String(inner.FromUserName ?? ''),
      chatType: 'group',
      senderId: String(inner.FromUserName ?? ''),
      senderName: 'unknown',
      text: String(inner.Content ?? ''),
      mentions: [],
      attachments: [],
      rawTimestamp: Date.now(),
    };
  }

  async sendReply(_reply: NormalizedReply, _target: ChatTarget): Promise<SendResult> {
    this.logger.warn('WeChat sendReply not yet implemented - to be done in Task 8');
    return { ok: false, error: 'not_implemented' };
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}