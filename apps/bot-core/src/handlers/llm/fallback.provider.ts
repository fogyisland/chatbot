import { ChatRequest, ChatResponse, LlmProvider } from './llm.types';
import { Logger } from '@nestjs/common';

/**
 * Wraps an ordered chain of LlmProviders. Tries each in order, returning
 * the first success. `defaultModel` is the model name of the FIRST
 * provider in the chain — so the LlmHandler and KbHandler can call
 * `provider.chat({ model: provider.defaultModel, ... })` and route
 * to the chain head by default.
 *
 * HandlersModule wires the chain as Tongyi → DeepSeek → OpenAI → Claude
 * (cheapest → most capable), so defaultModel = 'qwen-turbo' here.
 */
export class FallbackProvider implements LlmProvider {
  readonly name = 'fallback';
  readonly defaultModel: string;
  private readonly logger = new Logger(FallbackProvider.name);

  constructor(private readonly chain: LlmProvider[]) {
    this.defaultModel = chain[0]?.defaultModel ?? '';
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let lastErr: unknown;
    for (const p of this.chain) {
      try {
        return await p.chat(req);
      } catch (err) {
        this.logger.warn(`provider ${p.name} failed: ${err}; falling back`);
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('all providers failed');
  }

  countTokens(text: string): number { return Math.ceil(text.length / 4); }
}