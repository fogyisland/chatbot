import { Injectable, Logger } from '@nestjs/common';
import { NormalizedMessage, NormalizedReply } from '@mpcb/shared';
import { PlatformAdapter } from '../platform/platform-adapter.interface';
import { RouterService } from '../router/router.service';
import { LlmHandler } from '../handlers/llm/llm.handler';
import { KbHandler } from '../handlers/kb/kb.handler';
import { ToolRegistry } from '../handlers/tool/tool.handler';
import { RouteDecision } from '@mpcb/shared';

@Injectable()
export class MessageProcessor {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly router: RouterService,
    private readonly handlers: { llm: LlmHandler; kb: KbHandler; tool: ToolRegistry },
  ) {}

  async process(msg: NormalizedMessage): Promise<{ reply: NormalizedReply; target: { chatId: string; chatType: 'group' | 'direct' } }> {
    const abort = new AbortController();
    const decision = await this.router.route(msg, {
      userId: msg.senderId,
      chatId: msg.chatId,
      platform: msg.platform,
      history: [],
      abortSignal: abort.signal,
    });

    const reply = await this.dispatch(decision, msg, abort.signal);
    return { reply, target: { chatId: msg.chatId, chatType: msg.chatType } };
  }

  private async dispatch(decision: RouteDecision, msg: NormalizedMessage, signal: AbortSignal): Promise<NormalizedReply> {
    const ctx = {
      userId: msg.senderId,
      chatId: msg.chatId,
      platform: msg.platform,
      history: [],
      abortSignal: signal,
    };
    switch (decision.kind) {
      case 'llm': return this.handlers.llm.handle(decision, ctx);
      case 'kb': return this.handlers.kb.handle(decision, ctx);
      case 'tool': return this.handlers.tool.handle(decision, ctx);
      case 'command':
        return { text: `命令 ${decision.handler} 收到,参数:${decision.args || '(无)'} (MVP 占位)` };
      case 'unknown':
        return { text: `无法理解:${decision.reason}` };
    }
  }
}