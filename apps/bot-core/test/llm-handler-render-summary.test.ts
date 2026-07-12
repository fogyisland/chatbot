import { LlmHandler } from '../src/handlers/llm/llm.handler';
import { ChatMessage, LlmProvider, ChatResponse, ChatRequest } from '../src/handlers/llm/llm.types';
import { UsageLogger } from '../src/handlers/llm/usage-logger';

class StubProvider implements LlmProvider {
  readonly name = 'stub';
  readonly defaultModel = 'stub-1';
  readonly contextWindow = 200_000;
  public lastReq: ChatRequest | null = null;
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.lastReq = req;
    return { text: 'reply', model: 'stub-1', usage: { promptTokens: 0, completionTokens: 0 } };
  }
  countTokens(text: string): number { return Math.ceil(text.length / 4); }
}

describe('LlmHandler render: role:summary → role:user with prefix', () => {
  it('renders summary turns as user role with [Earlier conversation summary] prefix', async () => {
    const provider = new StubProvider();
    const usage = { record: jest.fn().mockResolvedValue(undefined) } as unknown as UsageLogger;
    const handler = new LlmHandler(provider, usage);

    const ctx = {
      userId: 'u1',
      chatId: 'c1',
      platform: 'wechat' as any,
      history: [
        { role: 'summary' as const, content: 'old summary text' },
        { role: 'user' as const, content: 'new question' },
      ],
      abortSignal: new AbortController().signal,
    };

    await handler.handle(
      { kind: 'llm', prompt: 'ignored (history present)' } as any,
      ctx,
    );

    const sent = provider.lastReq!.messages;
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const roles = sent.map((m) => m.role);
    expect(roles).not.toContain('summary');
    expect(roles.filter((r) => r === 'user').length).toBeGreaterThanOrEqual(2);
    expect(sent[0].role).toBe('user');
    expect(sent[0].content).toContain('[Earlier conversation summary]');
    expect(sent[0].content).toContain('old summary text');
  });

  it('history without summary → renders verbatim (no regression)', async () => {
    const provider = new StubProvider();
    const usage = { record: jest.fn().mockResolvedValue(undefined) } as unknown as UsageLogger;
    const handler = new LlmHandler(provider, usage);

    const ctx = {
      userId: 'u1',
      chatId: 'c1',
      platform: 'wechat' as any,
      history: [
        { role: 'user' as const, content: 'first question' },
        { role: 'assistant' as const, content: 'first answer' },
        { role: 'user' as const, content: 'follow-up' },
      ],
      abortSignal: new AbortController().signal,
    };

    await handler.handle(
      { kind: 'llm', prompt: 'final prompt' } as any,
      ctx,
    );

    const sent = provider.lastReq!.messages;
    expect(sent.length).toBe(4);
    expect(sent[0].role).toBe('user');
    expect(sent[0].content).toBe('first question');
    expect(sent[1].role).toBe('assistant');
    expect(sent[2].role).toBe('user');
    expect(sent[3].content).toBe('final prompt');
  });

  it('usage.log records the main call only (summary call is tracked by SummarizationService.usage)', async () => {
    const provider = new StubProvider();
    const usage = { record: jest.fn().mockResolvedValue(undefined) } as unknown as UsageLogger;
    const handler = new LlmHandler(provider, usage);

    const ctx = {
      userId: 'u1',
      chatId: 'c1',
      platform: 'wechat' as any,
      history: [{ role: 'summary' as const, content: 'x' }],
      abortSignal: new AbortController().signal,
    };

    await handler.handle({ kind: 'llm', prompt: 'p' } as any, ctx);

    expect(usage.record).toHaveBeenCalledTimes(1);
    expect((usage.record as jest.Mock).mock.calls[0][0].provider).toBe('stub');
    expect((usage.record as jest.Mock).mock.calls[0][0].model).toBe('stub-1');
  });
});
