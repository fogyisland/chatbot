import { FallbackProvider } from '../src/handlers/llm/fallback.provider';

const ok = (name: string, model = 'm') => ({
  name,
  defaultModel: model,
  chat: async () => ({ text: `${name}-ok`, usage: { promptTokens: 1, completionTokens: 1 }, model }),
  countTokens: () => 1,
});
const fail = (name: string, model = 'm') => ({
  name,
  defaultModel: model,
  chat: async () => { throw new Error(`${name}-down`); },
  countTokens: () => 1,
});

describe('FallbackProvider', () => {
  it('uses first provider when it succeeds', async () => {
    const fb = new FallbackProvider([ok('a'), ok('b')]);
    const r = await fb.chat({ model: 'm', messages: [] });
    expect(r.text).toBe('a-ok');
  });

  it('falls back to second when first throws', async () => {
    const fb = new FallbackProvider([fail('a'), ok('b')]);
    const r = await fb.chat({ model: 'm', messages: [] });
    expect(r.text).toBe('b-ok');
  });

  it('throws when all providers fail', async () => {
    const fb = new FallbackProvider([fail('a'), fail('b')]);
    await expect(fb.chat({ model: 'm', messages: [] })).rejects.toThrow(/b-down/);
  });

  it('defaultModel mirrors the first provider in the chain (qwen-turbo head)', () => {
    const fb = new FallbackProvider([
      ok('tongyi', 'qwen-turbo'),
      ok('deepseek', 'deepseek-chat'),
      ok('openai', 'gpt-4o-mini'),
    ]);
    expect(fb.defaultModel).toBe('qwen-turbo');
  });

  it('defaultModel is non-empty even when the chain is non-empty', () => {
    const fb = new FallbackProvider([ok('a')]);
    expect(fb.defaultModel).not.toBe('');
    expect(fb.defaultModel).toBe('m');
  });

  it('defaultModel is empty when chain is empty (degenerate)', () => {
    const fb = new FallbackProvider([]);
    expect(fb.defaultModel).toBe('');
  });

  it('falls through to last model when earlier providers all fail', async () => {
    let lastSeen = '';
    const finalProvider = {
      name: 'openai',
      defaultModel: 'gpt-4o-mini',
      chat: async (req: any) => {
        lastSeen = req.model;
        return { text: 'final', usage: { promptTokens: 0, completionTokens: 0 }, model: req.model };
      },
      countTokens: () => 0,
    };
    const fb = new FallbackProvider([fail('a', 'ma'), fail('b', 'mb'), finalProvider]);
    const r = await fb.chat({ model: 'caller-chosen', messages: [] });
    expect(r.text).toBe('final');
    // Caller-supplied model wins — fallback only changes provider, not model.
    expect(lastSeen).toBe('caller-chosen');
  });
});