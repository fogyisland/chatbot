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

  constructor(
    private readonly token: string,
    private readonly options: { accessToken?: string; apiBase?: string } = {},
  ) {}

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

  async sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult> {
    if (!reply.text) return { ok: true };
    const apiBase = this.options.apiBase ?? 'https://qyapi.weixin.qq.com';
    const accessToken = this.options.accessToken ?? '';
    const url = `${apiBase}/cgi-bin/message/custom/send?access_token=${accessToken}`;
    const body: any = {
      touser: target.chatId,
      msgtype: 'text',
      text: { content: reply.text },
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: any = await res.json();
      if (json.errcode === 0) return { ok: true };
      return { ok: false, error: `errcode=${json.errcode} errmsg=${json.errmsg}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}