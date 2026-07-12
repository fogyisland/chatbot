import { LlmHandler } from '../src/handlers/llm/llm.handler';
import { LlmProvider } from '../src/handlers/llm/llm.types';

function makeProvider(over: Partial<LlmProvider>): LlmProvider {
  return {
    name: 'stub',
    defaultModel: 'm',
    contextWindow: 1000,
    chat: async () => ({ text: 'r', model: 'm', usage: { promptTokens: 0, completionTokens: 0 } }),
    countTokens: () => 0,
    ...over,
  } as LlmProvider;
}

const noUsage = { record: async () => {} } as any;

describe('LlmHandler.contextWindow', () => {
  it('delegates to the underlying provider (single-provider wrap)', () => {
    const provider = makeProvider({ contextWindow: 200_000 });
    const handler = new LlmHandler(provider, noUsage);
    expect(handler.contextWindow).toBe(200_000);
  });

  it('delegates to FallbackProvider chain head (composition-style wrap)', () => {
    // Simulate FallbackProvider's getter exposing the head provider's window.
    const fallbackLike = {
      contextWindow: 64_000,   // chain head's value
    };
    // Cast through LlmProvider to satisfy the constructor.
    const handler = new LlmHandler(fallbackLike as unknown as LlmProvider, noUsage);
    expect(handler.contextWindow).toBe(64_000);
  });

  it('returns 0 when FallbackProvider chain is empty (degenerate v0.4 precedent)', () => {
    const fallbackLike = { contextWindow: 0 };
    const handler = new LlmHandler(fallbackLike as unknown as LlmProvider, noUsage);
    expect(handler.contextWindow).toBe(0);
  });
});
