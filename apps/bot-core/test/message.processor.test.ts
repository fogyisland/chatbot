import { MessageProcessor } from '../src/queue/message.processor';
import { NormalizedMessage, NormalizedReply, PlatformName } from '@mpcb/shared';
import { PlatformAdapter } from '../src/platform/platform-adapter.interface';

const baseMsg = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
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
  ...over,
});

describe('MessageProcessor', () => {
  const noLog = { upsertUser: async () => {}, upsertAssistant: async () => {}, upsertForgetBoundary: async () => {}, close: async () => {} } as any;
  const noConversation = { loadOrBuildHistory: async () => [] } as any;
  const noConfig = { historyTokenBudget: 0, historyBudgetRatio: 0.5 } as any;

  function makeAdapters(platform: 'wechat' | 'teams' | 'dingtalk') {
    const adapter: Partial<PlatformAdapter> = {
      platform,
      sendReply: jest.fn(async () => ({ ok: true, platformMessageId: `${platform}-1` })),
    };
    const map = new Map<PlatformName, PlatformAdapter>([[platform, adapter as PlatformAdapter]]);
    return { adapter: adapter as PlatformAdapter, map };
  }

  it('routes, dispatches, returns reply, and calls sendReply on correct adapter', async () => {
    const { adapter, map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'hello' }) };
    const kb = { handle: async () => ({ text: 'kb' }) };
    const tool = { handle: async () => ({ text: 'tool' }) };

    const proc = new MessageProcessor(map, router as any, { llm, kb, tool } as any, noLog, noConversation, noConfig);

    const result = await proc.process(baseMsg({ msgId: 'm1', platform: 'wechat' }));
    expect(result.reply.text).toBe('hello');
    expect(result.target.chatId).toBe('c1');
    expect(result.sent).toBe(true);
    expect(adapter.sendReply).toHaveBeenCalledTimes(1);
    expect(adapter.sendReply).toHaveBeenCalledWith(
      { text: 'hello' },
      { chatId: 'c1', chatType: 'group' },
    );
  });

  it('returns fallback reply when router returns unknown', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'unknown' as const, reason: 'no match' }) };
    const proc = new MessageProcessor(map, router as any, {} as any, noLog, noConversation, noConfig);
    const result = await proc.process(baseMsg({ msgId: 'm2' }));
    expect(result.reply.text).toContain('无法理解');
  });

  it('looks up the right adapter per platform (teams)', async () => {
    const wechatAdapter = { platform: 'wechat', sendReply: jest.fn() } as any;
    const teamsAdapter = { platform: 'teams', sendReply: jest.fn(async () => ({ ok: true })) } as any;
    const map = new Map<PlatformName, PlatformAdapter>([
      ['wechat', wechatAdapter as PlatformAdapter],
      ['teams', teamsAdapter as PlatformAdapter],
    ]);
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 't-reply' }) };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation, noConfig);

    const result = await proc.process(baseMsg({ msgId: 'm3', platform: 'teams', chatId: 'chat-t' }));
    expect(result.sent).toBe(true);
    expect(teamsAdapter.sendReply).toHaveBeenCalledTimes(1);
    expect(wechatAdapter.sendReply).not.toHaveBeenCalled();
  });

  it('looks up the right adapter per platform (dingtalk)', async () => {
    const dtAdapter = { platform: 'dingtalk', sendReply: jest.fn(async () => ({ ok: true })) } as any;
    const map = new Map<PlatformName, PlatformAdapter>([['dingtalk', dtAdapter as PlatformAdapter]]);
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'd-reply' }) };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation, noConfig);

    const result = await proc.process(baseMsg({ msgId: 'm4', platform: 'dingtalk' }));
    expect(result.sent).toBe(true);
    expect(dtAdapter.sendReply).toHaveBeenCalledTimes(1);
  });

  it('returns sent=false with sendError when adapter reports failure', async () => {
    const adapter = { platform: 'wechat', sendReply: async () => ({ ok: false, error: 'wechat-40001' }) } as any;
    const map = new Map<PlatformName, PlatformAdapter>([['wechat', adapter as PlatformAdapter]]);
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }) };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation, noConfig);

    const result = await proc.process(baseMsg({ msgId: 'm5' }));
    expect(result.sent).toBe(false);
    expect(result.sendError).toContain('40001');
  });

  it('returns sent=false when no adapter registered for platform', async () => {
    const map = new Map<PlatformName, PlatformAdapter>();
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }) };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation, noConfig);

    const result = await proc.process(baseMsg({ msgId: 'm6' }));
    expect(result.sent).toBe(false);
    expect(result.sendError).toContain('wechat');
  });

  it('builds a 30s AbortSignal and forwards it to router and llm', async () => {
    const { map } = makeAdapters('wechat');
    let routerSignal: AbortSignal | undefined;
    let llmSignal: AbortSignal | undefined;
    const router = {
      route: async (_msg: any, ctx: any) => {
        routerSignal = ctx.abortSignal;
        return { kind: 'llm' as const, prompt: 'hi' };
      },
    };
    const llm = {
      handle: async (_d: any, ctx: any) => {
        llmSignal = ctx.abortSignal;
        return { text: 'reply' };
      },
    };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation, noConfig);
    await proc.process(baseMsg({ msgId: 'm7' }));
    expect(routerSignal).toBeDefined();
    expect(llmSignal).toBeDefined();
    expect(routerSignal).toBe(llmSignal);
    expect(routerSignal!.aborted).toBe(false);
  });

  it('passes conversation history to router ctx (within session)', async () => {
    const { map } = makeAdapters('wechat');
    let routerHistory: any[] | undefined;
    const router = {
      route: async (_msg: any, ctx: any) => {
        routerHistory = ctx.history;
        return { kind: 'llm' as const, prompt: 'hi' };
      },
    };
    const llm = { handle: async () => ({ text: 'reply' }) };
    const conversation = {
      loadOrBuildHistory: async () => [
        { role: 'user' as const, content: 'prev-q' },
        { role: 'assistant' as const, content: 'prev-a' },
      ],
    };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any, noConfig);
    await proc.process(baseMsg({ msgId: 'mh1' }));
    expect(routerHistory).toEqual([
      { role: 'user', content: 'prev-q' },
      { role: 'assistant', content: 'prev-a' },
    ]);
  });

  it('degrades to empty history when ConversationService throws', async () => {
    const { map } = makeAdapters('wechat');
    let routerHistory: any[] | undefined;
    let llmHistory: any[] | undefined;
    const router = {
      route: async (_msg: any, ctx: any) => {
        routerHistory = ctx.history;
        return { kind: 'llm' as const, prompt: 'hi' };
      },
    };
    const llm = {
      handle: async (_d: any, ctx: any) => {
        llmHistory = ctx.history;
        return { text: 'reply' };
      },
    };
    const conversation = {
      loadOrBuildHistory: async () => { throw new Error('db down'); },
    };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any, noConfig);
    const result = await proc.process(baseMsg({ msgId: 'mh2' }));
    expect(result.reply.text).toBe('reply');
    expect(routerHistory).toEqual([]);
    expect(llmHistory).toEqual([]);
  });

  it('handles /forget verbosely: calls upsertForgetBoundary and returns confirmation text', async () => {
    const { map } = makeAdapters('wechat');
    let forgetCall: NormalizedMessage | undefined;
    const messageLog = {
      upsertUser: async () => {},
      upsertAssistant: async () => {},
      upsertForgetBoundary: async (m: NormalizedMessage) => { forgetCall = m; },
      close: async () => {},
    };
    const router = {
      route: async () => ({ kind: 'command' as const, handler: 'forget' as const, args: '' }),
      getConfig: async () => ({ commands: {}, prefixes: {}, defaultHandler: 'llm' as const, commandOnly: false, forgetReply: 'verbose' as const }),
    };
    const proc = new MessageProcessor(map, router as any, { llm: { handle: async () => ({ text: 'should-not-reach' }) }, kb: {}, tool: {} } as any, messageLog as any, noConversation, noConfig);

    const result = await proc.process(baseMsg({ msgId: 'fg1', text: '/forget' }));
    expect(result.reply.text).toBe('会话已重置, 请问有什么可以帮你?');
    expect(result.sent).toBe(true);
    expect(forgetCall).toBeDefined();
    expect(forgetCall?.msgId).toBe('fg1');
    expect(forgetCall?.senderId).toBe('u1');
  });

  it('handles /forget silently when forgetReply=silent: empty reply but still logs boundary', async () => {
    const { map } = makeAdapters('wechat');
    let forgetCalls = 0;
    const messageLog = {
      upsertUser: async () => {},
      upsertAssistant: async () => {},
      upsertForgetBoundary: async () => { forgetCalls++; },
      close: async () => {},
    };
    const router = {
      route: async () => ({ kind: 'command' as const, handler: 'forget' as const, args: '' }),
      getConfig: async () => ({ commands: {}, prefixes: {}, defaultHandler: 'llm' as const, commandOnly: false, forgetReply: 'silent' as const }),
    };
    const proc = new MessageProcessor(map, router as any, { llm: { handle: async () => ({ text: 'should-not-reach' }) }, kb: {}, tool: {} } as any, messageLog as any, noConversation, noConfig);

    const result = await proc.process(baseMsg({ msgId: 'fg2', text: '/forget' }));
    expect(result.reply.text).toBe('');
    expect(forgetCalls).toBe(1);
  });

  it('computeHistoryBudget: explicit cap (4321) beats perModel on long-context (200k * 0.5 = 100k)', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 200_000 };
    const loadOrBuildHistoryMock = jest.fn(async () => []);
    const cfg = { historyTokenBudget: 4321, historyBudgetRatio: 0.5 };
    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadOrBuildHistory: loadOrBuildHistoryMock } as any, cfg as any,
    );
    await proc.process(baseMsg({ msgId: 'budget1' }));
    expect((loadOrBuildHistoryMock.mock.calls[0] as any[])[4]).toEqual({ tokenBudget: 4321 });
  });

  it('computeHistoryBudget: perModel (4000) beats explicit (6000) on Tongyi-class 8k context', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 8_000 };
    const loadOrBuildHistoryMock = jest.fn(async () => []);
    const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0.5 };
    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadOrBuildHistory: loadOrBuildHistoryMock } as any, cfg as any,
    );
    await proc.process(baseMsg({ msgId: 'budget2' }));
    expect((loadOrBuildHistoryMock.mock.calls[0] as any[])[4]).toEqual({ tokenBudget: 4000 });
  });

  it('computeHistoryBudget: explicit=0 falls back to perModel (64k on 128k model, ratio 0.5)', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 128_000 };
    const loadOrBuildHistoryMock = jest.fn(async () => []);
    const cfg = { historyTokenBudget: 0, historyBudgetRatio: 0.5 };
    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadOrBuildHistory: loadOrBuildHistoryMock } as any, cfg as any,
    );
    await proc.process(baseMsg({ msgId: 'budget3' }));
    expect((loadOrBuildHistoryMock.mock.calls[0] as any[])[4]).toEqual({ tokenBudget: 64_000 });
  });

  it('computeHistoryBudget: ratio=0 disables perModel (effective = min(explicit, 0) = 0)', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 200_000 };
    const loadOrBuildHistoryMock = jest.fn(async () => []);
    const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0 };
    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadOrBuildHistory: loadOrBuildHistoryMock } as any, cfg as any,
    );
    await proc.process(baseMsg({ msgId: 'budget4' }));
    expect((loadOrBuildHistoryMock.mock.calls[0] as any[])[4]).toEqual({ tokenBudget: 0 });
  });

  it('computeHistoryBudget: empty FallbackProvider chain (ctxWindow=0) yields 0 even with explicit cap', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 0 };
    const loadOrBuildHistoryMock = jest.fn(async () => []);
    const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0.5 };
    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadOrBuildHistory: loadOrBuildHistoryMock } as any, cfg as any,
    );
    await proc.process(baseMsg({ msgId: 'budget5' }));
    expect((loadOrBuildHistoryMock.mock.calls[0] as any[])[4]).toEqual({ tokenBudget: 0 });
  });

  it('computeHistoryBudget: Math.floor applied (200001 * 0.5 = 100000.5 → 100000)', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 200_001 };
    const loadOrBuildHistoryMock = jest.fn(async () => []);
    const cfg = { historyTokenBudget: 0, historyBudgetRatio: 0.5 };
    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadOrBuildHistory: loadOrBuildHistoryMock } as any, cfg as any,
    );
    await proc.process(baseMsg({ msgId: 'budget6' }));
    expect((loadOrBuildHistoryMock.mock.calls[0] as any[])[4]).toEqual({ tokenBudget: 100_000 });
  });

  it('falls back to empty history when loadOrBuildHistory throws (no tokenBudget leak)', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'fallback' }) };
    const conversation = { loadOrBuildHistory: async () => { throw new Error('mysql down'); } };
    const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0.5 } as any;

    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any, cfg,
    );

    const result = await proc.process(baseMsg({ msgId: 'm-throw' }));
    expect(result.reply.text).toBe('fallback');
  });

  // v0.6.0 fail-open contract (spec §3.1, §4.3, §5): if loadOrBuildHistory
  // throws (e.g. SummarizationUnavailableError), MessageProcessor must
  // fall back to loadHistory so the user gets v0.5 FIFO behavior — NOT
  // strictly-worse empty history.
  it('fail-open: loadOrBuildHistory throws SummarizationUnavailableError → loadHistory fallback succeeds', async () => {
    const { map } = makeAdapters('wechat');
    let routerHistory: unknown[] | undefined;
    const router = {
      route: async (_msg: unknown, ctx: { history: unknown[] }) => {
        routerHistory = ctx.history;
        return { kind: 'llm' as const, prompt: 'hi' };
      },
    };
    const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 8_000 };
    const conversation = {
      loadOrBuildHistory: async () => {
        throw new Error('SummarizationUnavailableError: chain dead');
      },
      loadHistory: async () => [
        { role: 'user' as const, content: 'prev-q' },
        { role: 'assistant' as const, content: 'prev-a' },
      ],
    };
    const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0.5 };
    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any, cfg as any,
    );
    const result = await proc.process(baseMsg({ msgId: 'failopen1' }));
    expect(result.reply.text).toBe('reply');
    // The router received the v0.5 fallback history, NOT empty.
    expect(routerHistory).toEqual([
      { role: 'user', content: 'prev-q' },
      { role: 'assistant', content: 'prev-a' },
    ]);
  });

  it('fail-open: both loadOrBuildHistory AND loadHistory throw → empty history (final degrade)', async () => {
    const { map } = makeAdapters('wechat');
    let routerHistory: unknown[] | undefined;
    const router = {
      route: async (_msg: unknown, ctx: { history: unknown[] }) => {
        routerHistory = ctx.history;
        return { kind: 'llm' as const, prompt: 'hi' };
      },
    };
    const llm = { handle: async () => ({ text: 'still-replies' }), contextWindow: 8_000 };
    const conversation = {
      loadOrBuildHistory: async () => { throw new Error('summarizer dead'); },
      loadHistory: async () => { throw new Error('mysql dead'); },
    };
    const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0.5 };
    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any, cfg as any,
    );
    const result = await proc.process(baseMsg({ msgId: 'failopen2' }));
    expect(result.reply.text).toBe('still-replies');
    expect(routerHistory).toEqual([]);
  });
});
