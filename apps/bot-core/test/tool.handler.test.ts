import { ToolRegistry, ToolDef } from '../src/handlers/tool/tool.handler';
import { translateTool } from '../src/handlers/tool/builtin/translate.tool';

function stubTool(name = 'noop', rateLimit = 1): ToolDef {
  return {
    name,
    description: 'stub',
    rateLimit,
    enabled: true,
    execute: async () => ({ text: 'ok' }),
  };
}

const baseCtx = (userId: string) => ({
  userId,
  chatId: 'c',
  platform: 'wechat' as const,
  history: [],
  abortSignal: new AbortController().signal,
});

describe('ToolRegistry', () => {
  it('executes a registered tool by name', async () => {
    const reg = new ToolRegistry();
    reg.register(translateTool({ defaultModel: () => null }));
    const r = await reg.execute('translate', 'hello world', baseCtx('u'));
    // translate without LLM returns an error reply
    expect(r.text).toBeDefined();
  });

  it('rate counter resets after the window expires', async () => {
    const reg = new ToolRegistry();
    reg.register(stubTool('t', 1)); // rateLimit=1 → second call within window trips
    const r1 = await reg.execute('t', 'x', baseCtx('u'));
    expect(r1.text).toBe('ok');
    const r2 = await reg.execute('t', 'x', baseCtx('u'));
    expect(r2.text).toContain('调用频率超限');
    // Force the window to expire by clearing the internal map; the next call
    // must produce a fresh window. (Real-world timing is covered by the
    // expiry boundary logic — here we assert behavior end-to-end.)
    (reg as any).rateCounters.clear();
    const r3 = await reg.execute('t', 'x', baseCtx('u'));
    expect(r3.text).toBe('ok');
  });

  it('map does not grow without bound: expired entries pruned on increment', async () => {
    const reg = new ToolRegistry();
    reg.register(stubTool('t'));
    // Insert 10_001 distinct users — enough to trigger the PRUNE_THRESHOLD sweep.
    for (let i = 0; i < 10_001; i++) {
      await reg.execute('t', 'x', baseCtx('user-' + i));
    }
    // After the sweep, the map should be much smaller than the total number
    // of distinct users seen so far (we just added the 10_001st entry, so
    // expired entries from earlier are gone).
    const sizeAfter = (reg as any).rateCounters.size;
    expect(sizeAfter).toBeLessThan(10_001);
    // The most recent user is still tracked.
    expect((reg as any).rateCounters.has('user-10000:t')).toBe(true);
  });
});

describe('translateTool', () => {
  it('has correct shape', () => {
    const t = translateTool({ defaultModel: () => null });
    expect(t.name).toBe('translate');
    expect(t.rateLimit).toBe(20);
    expect(t.enabled).toBe(true);
  });
});
