import { LlmHandler } from '../src/handlers/llm/llm.handler';
import { HandlerContext } from '../src/handlers/handler.interface';

const baseCtx = (over: Partial<HandlerContext> = {}): HandlerContext => ({
  userId: 'u1',
  chatId: 'c1',
  platform: 'wechat',
  history: [],
  abortSignal: AbortSignal.timeout(30_000),
  ...over,
});

function makeHandler(capture: { messages?: any[] }) {
  const provider: any = {
    name: 'stub',
    defaultModel: 'm',
    chat: async (req: any) => {
      capture.messages = req.messages;
      return { text: 'reply', model: 'm', usage: { promptTokens: 1, completionTokens: 1 } };
    },
    countTokens: () => 1,
  };
  const usage: any = { record: async () => {} };
  return new LlmHandler(provider, usage);
}

describe('LlmHandler history propagation', () => {
  it('prepends ctx.history to messages and appends current user prompt', async () => {
    const cap: { messages?: any[] } = {};
    const handler = makeHandler(cap);
    const ctx = baseCtx({
      history: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    });
    await handler.handle({ kind: 'llm', prompt: 'q3' } as any, ctx);
    expect(cap.messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
    ]);
  });

  it('emits only [user] when history is empty (single-turn)', async () => {
    const cap: { messages?: any[] } = {};
    const handler = makeHandler(cap);
    const ctx = baseCtx({ history: [] });
    await handler.handle({ kind: 'llm', prompt: 'hi' } as any, ctx);
    expect(cap.messages).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('passes full ctx.history through (ConversationService caps at HISTORY_LIMIT=10)', async () => {
    const cap: { messages?: any[] } = {};
    const handler = makeHandler(cap);
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    const ctx = baseCtx({ history });
    await handler.handle({ kind: 'llm', prompt: 'NOW' } as any, ctx);
    expect(cap.messages).toHaveLength(11);
    expect(cap.messages![10]).toEqual({ role: 'user', content: 'NOW' });
    expect(cap.messages!.slice(0, 10).map((m: any) => m.content)).toEqual(['m0','m1','m2','m3','m4','m5','m6','m7','m8','m9']);
  });
});
