import { MessageProcessor } from '../src/queue/message.processor';
import { NormalizedMessage, NormalizedReply } from '@mpcb/shared';

describe('MessageProcessor', () => {
  it('routes, dispatches, and returns reply', async () => {
    const adapter = { sendReply: async () => ({ ok: true }) };
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'hello' }) };
    const kb = { handle: async () => ({ text: 'kb' }) };
    const tool = { handle: async () => ({ text: 'tool' }) };

    const proc = new MessageProcessor(
      adapter as any, router as any, { llm, kb, tool } as any,
    );

    const msg: NormalizedMessage = {
      msgId: 'm1', platform: 'wechat', chatId: 'c1', chatType: 'group',
      senderId: 'u1', senderName: 'A', text: 'hi', mentions: [], attachments: [], rawTimestamp: 0,
    };
    const result = await proc.process(msg);
    expect(result.reply.text).toBe('hello');
    expect(result.target.chatId).toBe('c1');
  });

  it('returns fallback reply when router returns unknown', async () => {
    const adapter = { sendReply: async () => ({ ok: true }) };
    const router = { route: async () => ({ kind: 'unknown' as const, reason: 'no match' }) };
    const proc = new MessageProcessor(adapter as any, router as any, {} as any);
    const msg: NormalizedMessage = {
      msgId: 'm2', platform: 'wechat', chatId: 'c1', chatType: 'group',
      senderId: 'u1', senderName: 'A', text: '?', mentions: [], attachments: [], rawTimestamp: 0,
    };
    const result = await proc.process(msg);
    expect(result.reply.text).toContain('无法理解');
  });
});