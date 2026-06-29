import { RouterService } from '../src/router/router.service';

const baseMsg = (text: string) => ({
  msgId: 'm', platform: 'wechat' as const, chatId: 'c', chatType: 'group' as const,
  senderId: 'u', senderName: 'A', text, mentions: [], attachments: [], rawTimestamp: 0,
});

describe('RouterService', () => {
  const svc = new RouterService({
    commands: { help: 'help', clear: 'clear', status: 'status' },
    prefixes: { kb: 'kb', tool: 'tool', ask: 'llm' },
    defaultHandler: 'llm',
    commandOnly: false,
  });

  it('routes /help to command handler', async () => {
    const d = await svc.route(baseMsg('/help'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('command');
    if (d.kind === 'command') expect(d.handler).toBe('help');
  });

  it('routes "kb: 报销" to kb handler with query', async () => {
    const d = await svc.route(baseMsg('kb: 报销'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('kb');
    if (d.kind === 'kb') expect(d.query).toBe('报销');
  });

  it('routes "tool: weather" to tool handler with name+args', async () => {
    const d = await svc.route(baseMsg('tool: weather 北京'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('tool');
    if (d.kind === 'tool') {
      expect(d.toolName).toBe('weather');
      expect(d.args).toBe('北京');
    }
  });

  it('falls back to llm for plain text in default mode', async () => {
    const d = await svc.route(baseMsg('你好'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('llm');
  });

  it('returns unknown when commandOnly and no command prefix', async () => {
    const cmdOnlySvc = new RouterService({
      commands: { help: 'help' },
      prefixes: { kb: 'kb' },
      defaultHandler: 'llm',
      commandOnly: true,
    });
    const d = await cmdOnlySvc.route(baseMsg('你好'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('unknown');
  });
});
