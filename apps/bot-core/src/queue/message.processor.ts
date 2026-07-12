import { Injectable, Logger } from '@nestjs/common';
import { NormalizedMessage, NormalizedReply, PlatformName } from '@mpcb/shared';
import { PlatformAdapter } from '../platform/platform-adapter.interface';
import { RouterService } from '../router/router.service';
import { LlmHandler } from '../handlers/llm/llm.handler';
import { KbHandler } from '../handlers/kb/kb.handler';
import { ToolRegistry } from '../handlers/tool/tool.handler';
import { RouteDecision } from '@mpcb/shared';
import { MessageLogService } from '../messages/message-log.service';
import { ConversationService, ConversationTurn } from '../conversation/conversation.service';
import { ConfigService } from '../common/config/config.service';

export interface ProcessResult {
  reply: NormalizedReply;
  target: { chatId: string; chatType: 'group' | 'direct' };
  sent: boolean;
  sendError?: string;
}

@Injectable()
export class MessageProcessor {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(
    private readonly adapters: Map<PlatformName, PlatformAdapter>,
    private readonly router: RouterService,
    private readonly handlers: { llm: LlmHandler; kb: KbHandler; tool: ToolRegistry },
    private readonly messageLog: MessageLogService,
    private readonly conversation: ConversationService,
    private readonly config: ConfigService,
  ) {}

  async process(msg: NormalizedMessage): Promise<ProcessResult> {
    // 30s timeout so a stuck downstream never holds the worker slot forever.
    const abortSignal = AbortSignal.timeout(30_000);

    // v0.6.0 fail-open contract (spec §3.1, §4.3, §5): if loadOrBuildHistory
    // throws (e.g. SummarizationUnavailableError when the summarizer chain
    // is dead), fall back to loadHistory so the user gets v0.5 FIFO behavior
    // instead of strictly worse (empty history).
    let history: ConversationTurn[] = [];
    try {
      history = await this.conversation.loadOrBuildHistory(
        msg.platform,
        msg.chatId,
        msg.senderId,
        Date.now(),
        { tokenBudget: this.computeHistoryBudget(), enableSummarization: this.config.enableSummarization },
      );
    } catch (err) {
      this.logger.warn(`loadOrBuildHistory threw; falling back to loadHistory: ${err instanceof Error ? err.message : String(err)}`);
      try {
        history = await this.conversation.loadHistory(
          msg.platform,
          msg.chatId,
          msg.senderId,
          Date.now(),
          { tokenBudget: this.computeHistoryBudget() },
        );
      } catch (err2) {
        this.logger.warn(`loadHistory fallback also threw; degrading to empty: ${err2 instanceof Error ? err2.message : String(err2)}`);
        history = [];
      }
    }

    const decision = await this.router.route(msg, {
      userId: msg.senderId,
      chatId: msg.chatId,
      platform: msg.platform,
      history,
      abortSignal,
    });

    const reply = await this.dispatch(decision, msg, abortSignal, history);
    const target = { chatId: msg.chatId, chatType: msg.chatType };

    // Log assistant reply BEFORE sendReply — that way even if the platform
    // delivery fails, the message is recorded for the admin Messages page.
    await this.messageLog.upsertAssistant(reply, msg.msgId, msg.platform, msg.chatId);

    const adapter = this.adapters.get(msg.platform);
    if (!adapter) {
      const err = `no adapter registered for platform=${msg.platform}`;
      this.logger.error(err);
      return { reply, target, sent: false, sendError: err };
    }

    try {
      const result = await adapter.sendReply(reply, target);
      if (!result.ok) {
        this.logger.warn(`sendReply failed platform=${msg.platform} err=${result.error ?? 'unknown'}`);
        return { reply, target, sent: false, sendError: result.error };
      }
      return { reply, target, sent: true };
    } catch (err) {
      const msg2 = err instanceof Error ? err.message : String(err);
      this.logger.error(`sendReply threw platform=${msg.platform}: ${msg2}`);
      return { reply, target, sent: false, sendError: msg2 };
    }
  }

  private async dispatch(
    decision: RouteDecision,
    msg: NormalizedMessage,
    signal: AbortSignal,
    history: ConversationTurn[],
  ): Promise<NormalizedReply> {
    const ctx = {
      userId: msg.senderId,
      chatId: msg.chatId,
      platform: msg.platform,
      history,
      abortSignal: signal,
    };
    switch (decision.kind) {
      case 'llm': return this.handlers.llm.handle(decision, ctx);
      case 'kb': return this.handlers.kb.handle(decision, ctx);
      case 'tool': return this.handlers.tool.handle(decision, ctx);
      case 'command':
        if (decision.handler === 'forget') {
          try {
            await this.messageLog.upsertForgetBoundary(msg);
          } catch (err) {
            // Boundary insert failed — fall back to a normal LLM reply so
            // the user sees SOMETHING rather than a silent failure.
            this.logger.warn(`upsertForgetBoundary failed; falling back to LLM: ${err instanceof Error ? err.message : String(err)}`);
            return this.handlers.llm.handle({ kind: 'llm', prompt: msg.text }, ctx);
          }
          const cfg = await this.router.getConfig();
          const mode = cfg.forgetReply ?? 'verbose';
          return { text: mode === 'silent' ? '' : '会话已重置, 请问有什么可以帮你?' };
        }
        return { text: `命令 ${decision.handler} 收到,参数:${decision.args || '(无)'} (MVP 占位)` };
      case 'unknown':
        return { text: `无法理解:${decision.reason}` };
    }
  }

  /**
   * Compute the effective per-message token budget for conversation history.
   *
   *   contextWindow  = handlers.llm.contextWindow         (e.g. 200_000 for Claude)
   *   ratio          = cfg.historyBudgetRatio             (env, default 0.5)
   *   explicit       = cfg.historyTokenBudget             (v0.4 env, 0 = unset)
   *
   *   perModel = Math.floor(contextWindow * ratio)
   *   effective = explicit > 0 ? Math.min(explicit, perModel) : perModel
   *
   * Reads three getters from already-injected dependencies; no caching,
   * no DB lookup, no router_config read. Called once per process() call.
   */
  private computeHistoryBudget(): number {
    const contextWindow = this.handlers.llm.contextWindow;
    const ratio = this.config.historyBudgetRatio;
    const explicit = this.config.historyTokenBudget;
    const perModel = Math.floor(contextWindow * ratio);
    return explicit > 0 ? Math.min(explicit, perModel) : perModel;
  }
}
