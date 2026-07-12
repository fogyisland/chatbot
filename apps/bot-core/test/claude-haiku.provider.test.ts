import { ConfigService } from '../src/common/config/config.service';
import { ClaudeHaikuProvider } from '../src/handlers/summarizer/providers/claude-haiku.provider';
import { ClaudeProvider } from '../src/handlers/llm/providers/claude.provider';

describe('ClaudeHaikuProvider', () => {
  it('overrides name and defaultModel from the parent ClaudeProvider', () => {
    const p = new ClaudeHaikuProvider(new ConfigService());
    expect(p.name).toBe('claude-haiku');
    expect(p.defaultModel).toBe('claude-haiku-4-5');
    // Inherits large context window from ClaudeProvider
    expect(p.contextWindow).toBe(200_000);
  });

  it('is-a ClaudeProvider (inherits countTokens implementation)', () => {
    const p = new ClaudeHaikuProvider(new ConfigService());
    expect(p).toBeInstanceOf(ClaudeProvider);
    // inherited
    expect(p.countTokens('abc')).toBeGreaterThanOrEqual(1);
  });
});
