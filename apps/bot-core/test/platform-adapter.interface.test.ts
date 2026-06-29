import {
  PlatformAdapter,
  RawRequest,
  SendResult,
} from '../src/platform/platform-adapter.interface';
import {
  NormalizedMessage,
  NormalizedReply,
  ChatTarget,
  MediaRef,
  MediaType,
} from '@mpcb/shared';

class FakeAdapter implements PlatformAdapter {
  readonly platform = 'wechat' as const;
  async parseInbound(_req: RawRequest): Promise<NormalizedMessage> {
    return {
      msgId: 'm1',
      platform: 'wechat',
      chatId: 'c1',
      chatType: 'group',
      senderId: 'u1',
      senderName: 'A',
      text: 'hi',
      mentions: [],
      attachments: [],
      rawTimestamp: 0,
    };
  }
  verifySignature(_req: RawRequest): boolean {
    return true;
  }
  async sendReply(_reply: NormalizedReply, _t: ChatTarget): Promise<SendResult> {
    return { ok: true };
  }
  async uploadMedia(_b: Buffer, _t: MediaType): Promise<MediaRef> {
    return { platformMediaId: 'x' };
  }
}

describe('PlatformAdapter contract', () => {
  it('parseInbound returns a NormalizedMessage', async () => {
    const a = new FakeAdapter();
    const m = await a.parseInbound({} as any);
    expect(m.platform).toBe('wechat');
  });

  it('verifySignature returns boolean', () => {
    expect(new FakeAdapter().verifySignature({} as any)).toBe(true);
  });

  it('sendReply returns SendResult', async () => {
    expect(
      await new FakeAdapter().sendReply(
        { text: 'hi' },
        { chatId: 'c', chatType: 'group' },
      ),
    ).toEqual({ ok: true });
  });

  it('uploadMedia returns MediaRef', async () => {
    expect(
      await new FakeAdapter().uploadMedia(Buffer.from(''), 'image'),
    ).toEqual({ platformMediaId: 'x' });
  });
});