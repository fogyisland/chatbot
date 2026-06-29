import { ChatRequest, ChatResponse, LlmProvider } from './llm.types';
import { Logger } from '@nestjs/common';

export class FallbackProvider implements LlmProvider {
  readonly name = 'fallback';
  readonly defaultModel = '';
  private readonly logger = new Logger(FallbackProvider.name);

  constructor(private readonly chain: LlmProvider[]) {}

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