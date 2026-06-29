import { FallbackProvider } from '../src/handlers/llm/fallback.provider';

const ok = (name: string) => ({ name, defaultModel: 'm', chat: async () => ({ text: `${name}-ok`, usage: { promptTokens: 1, completionTokens: 1 }, model: 'm' }), countTokens: () => 1 });
const fail = (name: string) => ({ name, defaultModel: 'm', chat: async () => { throw new Error(`${name}-down`); }, countTokens: () => 1 });

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
});