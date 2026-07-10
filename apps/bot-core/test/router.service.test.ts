import { RouterService } from '../src/router/router.service';
import { RouterConfigStore } from '../src/router/router-config.store';

const baseMsg = (text: string) => ({
  msgId: 'm', platform: 'wechat' as const, chatId: 'c', chatType: 'group' as const,
  senderId: 'u', senderName: 'A', text, mentions: [], attachments: [], rawTimestamp: 0,
});

const ctx = { userId: 'u', chatId: 'c', platform: 'wechat' as const, history: [], abortSignal: new AbortController().signal };

describe('RouterService', () => {
  const svc = new RouterService({
    commands: { help: 'help', clear: 'clear', status: 'status', forget: 'forget' },
    prefixes: { kb: 'kb', tool: 'tool', ask: 'llm' },
    defaultHandler: 'llm',
    commandOnly: false,
    forgetReply: 'verbose',
  });

  it('routes /help to command handler', async () => {
    const d = await svc.route(baseMsg('/help'), ctx);
    expect(d.kind).toBe('command');
    if (d.kind === 'command') expect(d.handler).toBe('help');
  });

  it('routes /forget to command handler with handler=forget', async () => {
    const d = await svc.route(baseMsg('/forget'), ctx);
    expect(d.kind).toBe('command');
    if (d.kind === 'command') expect(d.handler).toBe('forget');
  });

  it('routes "kb: 报销" to kb handler with query', async () => {
    const d = await svc.route(baseMsg('kb: 报销'), ctx);
    expect(d.kind).toBe('kb');
    if (d.kind === 'kb') expect(d.query).toBe('报销');
  });

  it('routes "tool: weather" to tool handler with name+args', async () => {
    const d = await svc.route(baseMsg('tool: weather 北京'), ctx);
    expect(d.kind).toBe('tool');
    if (d.kind === 'tool') {
      expect(d.toolName).toBe('weather');
      expect(d.args).toBe('北京');
    }
  });

  it('falls back to llm for plain text in default mode', async () => {
    const d = await svc.route(baseMsg('你好'), ctx);
    expect(d.kind).toBe('llm');
  });

  it('returns unknown when commandOnly and no command prefix', async () => {
    const cmdOnlySvc = new RouterService({
      commands: { help: 'help' },
      prefixes: { kb: 'kb' },
      defaultHandler: 'llm',
      commandOnly: true,
      forgetReply: 'verbose',
    });
    const d = await cmdOnlySvc.route(baseMsg('你好'), ctx);
    expect(d.kind).toBe('unknown');
  });
});

describe('RouterService with RouterConfigStore', () => {
  it('loads rules from MySQL and reflects them in routing decisions', async () => {
    // Stub the store to return a custom config without hitting MySQL.
    const store: any = {
      getConfig: jest.fn(async () => ({
        commands: { ping: 'help', echo: 'clear' },
        prefixes: { doc: 'kb' },
        defaultHandler: 'llm',
        commandOnly: true,
        forgetReply: 'verbose',
      })),
    };
    const svc = new RouterService(store);

    // 1. /ping now maps to the help handler (custom command from MySQL).
    const cmd = await svc.route(baseMsg('/ping'), ctx);
    expect(cmd.kind).toBe('command');
    if (cmd.kind === 'command') expect(cmd.handler).toBe('help');

    // 2. doc:foo now maps to KB (custom prefix from MySQL).
    const kb = await svc.route(baseMsg('doc: foo'), ctx);
    expect(kb.kind).toBe('kb');
    if (kb.kind === 'kb') expect(kb.query).toBe('foo');

    // 3. With commandOnly=true in MySQL, plain text is unknown.
    const plain = await svc.route(baseMsg('hi'), ctx);
    expect(plain.kind).toBe('unknown');

    expect(store.getConfig).toHaveBeenCalled();
  });

  it('falls back to defaults when store.getConfig throws', async () => {
    const store: any = {
      getConfig: jest.fn(async () => { throw new Error('mysql down'); }),
    };
    const svc = new RouterService(store);
    // Default config has commands.help → 'help', so /help should still work.
    const d = await svc.route(baseMsg('/help'), ctx);
    expect(d.kind).toBe('command');
    if (d.kind === 'command') expect(d.handler).toBe('help');
  });

  it('caches the loaded config across multiple route() calls within 60s', async () => {
    const store: any = {
      getConfig: jest.fn(async () => ({
        commands: { help: 'help' },
        prefixes: { kb: 'kb' },
        defaultHandler: 'llm',
        commandOnly: false,
        forgetReply: 'verbose',
      })),
    };
    const svc = new RouterService(store);
    await svc.route(baseMsg('/help'), ctx);
    await svc.route(baseMsg('/help'), ctx);
    await svc.route(baseMsg('/help'), ctx);
    // Store hit should equal the number of times we crossed the 60s window.
    // 3 calls inside the same window → 1 store fetch.
    expect(store.getConfig).toHaveBeenCalledTimes(1);
  });
});
