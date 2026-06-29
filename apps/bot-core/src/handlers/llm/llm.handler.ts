import { Injectable, Logger } from '@nestjs/common';
import { NormalizedReply, RouteDecision } from '@mpcb/shared';
import { Handler, HandlerContext } from '../handler.interface';
import { LlmProvider } from './llm.types';

@Injectable()
export class LlmHandler implements Handler {
  readonly name = 'llm';
  private readonly logger = new Logger(LlmHandler.name);

  constructor(private readonly provider: LlmProvider) {}

  async handle(input: RouteDecision & { kind: 'llm' }, ctx: HandlerContext): Promise<NormalizedReply> {
    try {
      const recent = ctx.history.slice(-5);
      const messages = [
        ...recent.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: input.prompt },
      ];

      const resp = await this.provider.chat({
        model: this.provider.defaultModel,
        systemPrompt: input.systemPrompt,
        messages,
        signal: ctx.abortSignal,
      });

      return { text: resp.text };
    } catch (e) {
      this.logger.error(`llm handler error: ${(e as Error).message}`);
      return { text: '抱歉,服务暂时不可用,请稍后再试。' };
    }
  }
}