import { Injectable, Logger } from '@nestjs/common';
import { NormalizedReply, RouteDecision } from '@mpcb/shared';
import { Handler, HandlerContext } from '../handler.interface';
import { LlmProvider, ChatRequest } from './llm.types';
import { UsageLogger } from './usage-logger';

@Injectable()
export class LlmHandler implements Handler {
  readonly name = 'llm';
  private readonly logger = new Logger(LlmHandler.name);

  constructor(
    private readonly provider: LlmProvider,
    private readonly usage: UsageLogger,
  ) {}

  async handle(input: RouteDecision & { kind: 'llm' }, ctx: HandlerContext): Promise<NormalizedReply> {
    const req: ChatRequest = {
      model: this.provider.defaultModel,
      systemPrompt: input.systemPrompt,
      messages: [
        ...ctx.history,
        { role: 'user', content: input.prompt },
      ],
      // Forward caller-supplied abort signal so a 30s timeout (or worker
      // shutdown) cancels the upstream LLM request.
      signal: ctx.abortSignal,
    };
    try {
      const resp = await this.provider.chat(req);
      await this.usage.record({
        userId: ctx.userId,
        provider: this.provider.name,
        model: resp.model,
        usage: resp.usage,
      }).catch((e) => this.logger.warn(`usage log failed: ${e}`));
      return { text: resp.text };
    } catch (err) {
      this.logger.error(`LLM error: ${err}`);
      return { text: '抱歉,服务暂时不可用,请稍后再试。' };
    }
  }
}