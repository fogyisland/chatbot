import {
  PlatformName,
  NormalizedMessage,
  NormalizedReply,
  RouteDecision,
} from '../src';

describe('shared types', () => {
  it('PlatformName is a string literal union', () => {
    const p: PlatformName = 'wechat';
    expect(['wechat', 'teams', 'dingtalk']).toContain(p);
  });

  it('NormalizedMessage accepts a fully populated object', () => {
    const m: NormalizedMessage = {
      msgId: 'm1',
      platform: 'wechat',
      chatId: 'c1',
      chatType: 'group',
      senderId: 'u1',
      senderName: 'Alice',
      text: 'hello',
      mentions: ['u2'],
      attachments: [],
      rawTimestamp: Date.now(),
    };
    expect(m.msgId).toBe('m1');
  });

  it('NormalizedReply allows text-only', () => {
    const r: NormalizedReply = { text: 'hi' };
    expect(r.text).toBe('hi');
  });

  it('RouteDecision discriminates on kind', () => {
    const d: RouteDecision = { kind: 'llm', prompt: 'hello' };
    if (d.kind === 'llm') {
      expect(d.prompt).toBe('hello');
    }
  });
});
