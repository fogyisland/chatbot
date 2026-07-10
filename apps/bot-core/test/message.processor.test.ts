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
  const noConversation = { loadHistory: async () => [] } as any;

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

    const proc = new MessageProcessor(map, router as any, { llm, kb, tool } as any, noLog, noConversation);

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
    const proc = new MessageProcessor(map, router as any, {} as any, noLog, noConversation);
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
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation);

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
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation);

    const result = await proc.process(baseMsg({ msgId: 'm4', platform: 'dingtalk' }));
    expect(result.sent).toBe(true);
    expect(dtAdapter.sendReply).toHaveBeenCalledTimes(1);
  });

  it('returns sent=false with sendError when adapter reports failure', async () => {
    const adapter = { platform: 'wechat', sendReply: async () => ({ ok: false, error: 'wechat-40001' }) } as any;
    const map = new Map<PlatformName, PlatformAdapter>([['wechat', adapter as PlatformAdapter]]);
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }) };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation);

    const result = await proc.process(baseMsg({ msgId: 'm5' }));
    expect(result.sent).toBe(false);
    expect(result.sendError).toContain('40001');
  });

  it('returns sent=false when no adapter registered for platform', async () => {
    const map = new Map<PlatformName, PlatformAdapter>();
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }) };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation);

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
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, noConversation);
    await proc.process(baseMsg({ msgId: 'm7' }));
    expect(routerSignal).toBeDefined();
    expect(llmSignal).toBeDefined();
    expect(routerSignal).toBe(llmSignal); // same signal instance
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
      loadHistory: async () => [
        { role: 'user' as const, content: 'prev-q' },
        { role: 'assistant' as const, content: 'prev-a' },
      ],
    };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any);
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
      loadHistory: async () => { throw new Error('db down'); },
    };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any);
    const result = await proc.process(baseMsg({ msgId: 'mh2' }));
    expect(result.reply.text).toBe('reply');          // worker still completes
    expect(routerHistory).toEqual([]);                  // router sees empty history
    expect(llmHistory).toEqual([]);                     // handler sees empty history
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
    const proc = new MessageProcessor(map, router as any, { llm: { handle: async () => ({ text: 'should-not-reach' }) }, kb: {}, tool: {} } as any, messageLog as any, noConversation);

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
    const proc = new MessageProcessor(map, router as any, { llm: { handle: async () => ({ text: 'should-not-reach' }) }, kb: {}, tool: {} } as any, messageLog as any, noConversation);

    const result = await proc.process(baseMsg({ msgId: 'fg2', text: '/forget' }));
    expect(result.reply.text).toBe('');
    expect(forgetCalls).toBe(1);  // boundary still inserted even when silent
  });
});
