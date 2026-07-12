import { ConfigService } from '../src/common/config/config.service';
import { OpenAIMiniProvider } from '../src/handlers/summarizer/providers/openai-mini.provider';
import { OpenAIProvider } from '../src/handlers/llm/providers/openai.provider';

describe('OpenAIMiniProvider', () => {
  it('overrides name and defaultModel from the parent OpenAIProvider', () => {
    const p = new OpenAIMiniProvider(new ConfigService());
    expect(p.name).toBe('openai-mini');
    expect(p.defaultModel).toBe('gpt-4o-mini');
    // Inherits large OpenAI context window
    expect(p.contextWindow).toBe(128_000);
  });

  it('is-a OpenAIProvider (inherits countTokens implementation)', () => {
    const p = new OpenAIMiniProvider(new ConfigService());
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.countTokens('abc')).toBeGreaterThanOrEqual(1);
  });
});
