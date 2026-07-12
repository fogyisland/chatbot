import { Inject, Injectable, Logger } from '@nestjs/common';
import { estimateTokens } from '@mpcb/shared';
import { ConfigService } from '../../common/config/config.service';
import { ConversationTurn } from '../../conversation/conversation.service';
import { ChatRequest } from '../llm/llm.types';
import { UsageLogger } from '../llm/usage-logger';
import {
  PREVIOUS_SUMMARY_HEADER,
  SUMMARIZER_PROVIDERS,
  SUMMARIZER_SYSTEM_PROMPT,
  SummarizationUnavailableError,
} from './summarizer.types';
import { LlmProvider } from '../llm/llm.types';

/**
 * v0.6: condensed-history producer for over-budget conversations.
 *
 * Tries the configured summarizer-provider chain in order. The first
 * successful response wins; subsequent providers in the chain are
 * tried only on failure (mirrors FallbackProvider semantics without
 * the wrapping class — we need the actual provider name for usage_log).
 *
 * On full-chain failure, throws SummarizationUnavailableError so the
 * caller (ConversationService.loadOrBuildHistory) can fail-open to
 * v0.5 FIFO-drop behavior.
 */
@Injectable()
export class SummarizationService {
  private readonly logger = new Logger(SummarizationService.name);

  constructor(
    @Inject(SUMMARIZER_PROVIDERS) private readonly providers: LlmProvider[],
    private readonly usage: UsageLogger,
    private readonly cfg: ConfigService,
  ) {}

  /** Exposes the input pre-trim budget (70% of context window). Parity with LlmHandler.contextWindow. */
  get contextWindow(): number {
    return this.cfg.summarizerContextWindow;
  }

  async summarize(turns: ConversationTurn[], signal: AbortSignal): Promise<string> {
    const prepared = this.prepareInput(turns);
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        const req: ChatRequest = {
          model: p.defaultModel,
          systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: prepared.userMessage },
          ],
          signal,
        };
        const resp = await p.chat(req);
        await this.usage.record({
          userId: undefined,           // sessions keyed by sessionKey, not user PK
          provider: p.name,
          model: resp.model,
          usage: resp.usage,
        }).catch((e) => this.logger.warn(`usage log failed: ${e instanceof Error ? e.message : String(e)}`));
        return resp.text.trim();
      } catch (err) {
        this.logger.warn(`summarizer provider ${p.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        lastErr = err;
      }
    }
    throw new SummarizationUnavailableError(lastErr);
  }

  /**
   * Build the user-message content for the summarizer call:
   *   - If a prior summary is detected in the first turn (heuristic: it has role:'user'
   *     and content begins with the PREVIOUS_SUMMARY_HEADER marker), prepend it.
   *   - Otherwise, just dump the transcript.
   *   - Pre-trim oldest turns to fit within 70% of summarizerContextWindow.
   */
  private prepareInput(turns: ConversationTurn[]): { userMessage: string } {
    let priorSummary: string | null = null;
    let remainder: ConversationTurn[] = turns;

    // Detect prior summary pattern: caller may pass the most-recent
    // summary as a regular conversation turn with `role: 'user'` and
    // a content prefixed by our header. ConversationService passes a
    // plain `role: 'user'` placeholder for prior summary (see T5).
    // For simplicity here, we accept either: an explicit
    // [{role:'system', content: PREVIOUS_SUMMARY_HEADER + ...}] turn,
    // or nothing (no prior summary).
    const idx = turns.findIndex(
      (t) => t.role === 'user' && t.content.startsWith(PREVIOUS_SUMMARY_HEADER),
    );
    if (idx >= 0) {
      priorSummary = turns[idx].content.slice(PREVIOUS_SUMMARY_HEADER.length);
      remainder = [...turns.slice(0, idx), ...turns.slice(idx + 1)];
    }

    const inputCap = Math.floor(this.cfg.summarizerContextWindow * 0.7);
    const transcript = remainder
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
    const priorBlock = priorSummary ? `PREVIOUS SUMMARY:\n${priorSummary}\n\nNEW TURNS:\n` : '';
    let userMessage = priorBlock + transcript;

    // Pre-trim: drop oldest "User/Assistant:" lines until total tokens ≤ inputCap.
    while (estimateTokens(userMessage) > inputCap) {
      const lines = userMessage.split('\n');
      if (lines.length <= 1) break;       // avoid infinite loop; remaining is one block
      lines.shift();                       // drop oldest line
      userMessage = lines.join('\n');
    }
    return { userMessage };
  }
}
