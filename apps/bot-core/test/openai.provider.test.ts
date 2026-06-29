import { OpenAIProvider } from '../src/handlers/llm/providers/openai.provider';

describe('OpenAIProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chat posts to /v1/chat/completions with correct shape, Bearer auth, and system prompt prepended', async () => {
    let captured: { url: any; init: any } | null = null;
    global.fetch = async (_url: any, init: any) => {
      captured = { url: _url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'cmpl-1',
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello back' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
        }),
      } as any;
    };

    const p = new OpenAIProvider({ apiKey: 'sk-test', baseUrl: 'https://api.example.com' });
    const r = await p.chat({
      model: 'gpt-4o-mini',
      systemPrompt: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(captured).not.toBeNull();
    expect(captured!.url).toContain('/v1/chat/completions');
    expect(captured!.init.method).toBe('POST');

    const headers = captured!.init.headers;
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(captured!.init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBeDefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);

    expect(r.text).toBe('hello back');
    expect(r.usage.promptTokens).toBe(7);
    expect(r.usage.completionTokens).toBe(4);
  });

  it('chat throws on non-OK response', async () => {
    global.fetch = async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => 'unauthorized',
      } as any);
    const p = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    await expect(p.chat({ model: 'gpt-4o-mini', messages: [] })).rejects.toThrow(/401/);
  });

  it('countTokens approximates ceil(text.length/4)', () => {
    const p = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    expect(p.countTokens('abcdefgh')).toBe(2);
    expect(p.countTokens('')).toBe(0);
    expect(p.countTokens('a')).toBe(1);
  });
});
