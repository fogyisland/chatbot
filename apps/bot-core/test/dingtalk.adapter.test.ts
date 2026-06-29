import { DingTalkAdapter } from '../src/platform/dingtalk/dingtalk.adapter';
import { createHmac } from 'crypto';

describe('DingTalkAdapter', () => {
  const secret = 'SEC';
  let a: DingTalkAdapter;

  beforeEach(() => {
    a = new DingTalkAdapter({ appKey: 'appKey', appSecret: secret });
  });

  it('verifySignature computes HMAC-SHA256 correctly', () => {
    const ts = '1700000000';
    const stringToSign = `${ts}\n${secret}`;
    const sign = createHmac('sha256', secret).update(stringToSign).digest('base64');
    expect(a.verifySignature({ headers: {}, body: {}, query: { timestamp: ts, sign } } as any)).toBe(true);
  });

  it('verifySignature returns false on bad signature', () => {
    expect(a.verifySignature({ headers: {}, body: {}, query: { timestamp: '1', sign: 'bad' } } as any)).toBe(false);
  });

  it('parseInbound extracts text from stream callback', async () => {
    const m = await a.parseInbound({
      headers: {}, query: {},
      body: {
        msgId: 'd1',
        conversationId: 'g1',
        conversationType: '2',
        senderId: 'u1',
        senderNick: 'Carol',
        text: { content: 'hi ding' },
      },
    } as any);
    expect(m.platform).toBe('dingtalk');
    expect(m.text).toBe('hi ding');
    expect(m.chatType).toBe('group');
  });
});
