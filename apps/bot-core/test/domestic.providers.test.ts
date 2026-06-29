import { TongyiProvider } from '../src/handlers/llm/providers/tongyi.provider';
import { DeepSeekProvider } from '../src/handlers/llm/providers/deepseek.provider';

describe('TongyiProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chat posts to /compatible-mode/v1/chat/completions with Bearer auth and returns parsed text/usage', async () => {
    let captured: { url: any; init: any } | null = null;
    global.fetch = async (_url: any, init: any) => {
      captured = { url: _url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'qwen-turbo',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'tongyi hi' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        }),
      } as any;
    };

    const p = new TongyiProvider({ apiKey: 'sk-tongyi', baseUrl: 'https://api.example.com' });
    const r = await p.chat({
      model: 'qwen-turbo',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(captured).not.toBeNull();
    expect(String(captured!.url)).toContain('/compatible-mode/v1/chat/completions');
    const headers = captured!.init.headers;
    expect(headers['authorization']).toBe('Bearer sk-tongyi');

    expect(r.text).toBe('tongyi hi');
    expect(r.usage.promptTokens).toBe(8);
    expect(r.usage.completionTokens).toBe(3);
  });
});

describe('DeepSeekProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chat posts to /chat/completions with Bearer auth and returns parsed text/usage', async () => {
    let captured: { url: any; init: any } | null = null;
    global.fetch = async (_url: any, init: any) => {
      captured = { url: _url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek-chat',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'deepseek hi' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        }),
      } as any;
    };

    const p = new DeepSeekProvider({ apiKey: 'sk-deepseek', baseUrl: 'https://api.example.com' });
    const r = await p.chat({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(captured).not.toBeNull();
    expect(String(captured!.url)).toContain('/chat/completions');
    const headers = captured!.init.headers;
    expect(headers['authorization']).toBe('Bearer sk-deepseek');

    expect(r.text).toBe('deepseek hi');
    expect(r.usage.promptTokens).toBe(9);
    expect(r.usage.completionTokens).toBe(4);
  });
});
