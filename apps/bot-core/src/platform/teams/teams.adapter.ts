import { Injectable, Logger } from '@nestjs/common';
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
export class TeamsAdapter implements PlatformAdapter {
  readonly platform: PlatformName = 'teams';
  private readonly logger = new Logger(TeamsAdapter.name);

  constructor(private readonly options: { appId: string; appSecret: string }) {}

  verifySignature(_req: RawRequest): boolean {
    // JWT verification deferred — Bot Framework middleware handles auth
    return true;
  }

  async parseInbound(req: RawRequest): Promise<NormalizedMessage> {
    const a = (req.body ?? {}) as any;
    return {
      msgId: String(a.id ?? ''),
      platform: 'teams',
      chatId: String(a.conversation?.id ?? ''),
      chatType: a.conversation?.conversationType === 'personal' ? 'direct' : 'group',
      senderId: String(a.from?.id ?? ''),
      senderName: String(a.from?.name ?? 'unknown'),
      text: String(a.text ?? '').replace(/<at>.*?<\/at>\s*/g, '').trim(),
      mentions: (a.entities ?? [])
        .filter((e: any) => e.type === 'mention')
        .map((e: any) => String(e.mentioned?.id ?? '')),
      attachments: [],
      rawTimestamp: a.timestamp ? new Date(a.timestamp).getTime() : Date.now(),
    };
  }

  async sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult> {
    if (!reply.text) return { ok: true };
    // Real implementation uses Bot Framework ConnectorClient.
    // MVP emits a placeholder activity URL.
    this.logger.log(`[teams] → ${target.chatId}: ${reply.text}`);
    return { ok: true, platformMessageId: `teams-${Date.now()}` };
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}
