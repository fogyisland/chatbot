import { ToolRegistry } from '../src/handlers/tool/tool.handler';
import { translateTool } from '../src/handlers/tool/builtin/translate.tool';

describe('ToolRegistry', () => {
  it('executes a registered tool by name', async () => {
    const reg = new ToolRegistry();
    reg.register(translateTool({ defaultModel: () => null }));
    const r = await reg.execute('translate', 'hello world', { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    // translate without LLM returns an error reply
    expect(r.text).toBeDefined();
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
