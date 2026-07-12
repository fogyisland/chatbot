import { Injectable, Logger } from '@nestjs/common';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';
import { PlatformName, estimateTokens } from '@mpcb/shared';
import { ConfigService } from '../common/config/config.service';
import { SummarizationService } from '../handlers/summarizer/summarizer.service';
import { PREVIOUS_SUMMARY_HEADER } from '../handlers/summarizer/summarizer.types';
import { MessageLogService } from '../messages/message-log.service';

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system' | 'summary';
  content: string;
}

export interface LoadHistoryOptions {
  tokenBudget?: number;
}

@Injectable()
export class ConversationService {
  private static readonly FETCH_LIMIT = 20;
  private static readonly SESSION_IDLE_MS = 30 * 60 * 1000;
  private static readonly BOUNDARY_CONTENT = '__forget_boundary__';

  private readonly logger = new Logger(ConversationService.name);
  private pool: Pool | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly summarizer: SummarizationService,
    private readonly messageLog: MessageLogService,
  ) {}

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = createPool({
        host: this.cfg.mysqlHost,
        port: this.cfg.mysqlPort,
        user: this.cfg.mysqlUser,
        password: this.cfg.mysqlPassword,
        database: this.cfg.mysqlDatabase,
        connectionLimit: 5,
      });
    }
    return this.pool;
  }

  async loadHistory(
    platform: PlatformName,
    chatId: string,
    senderId: string,
    now: number,
    options?: LoadHistoryOptions,
  ): Promise<ConversationTurn[]> {
    let rows: Array<{ role: 'user' | 'assistant' | 'system' | 'summary'; content: string; created_at: Date }>;
    try {
      const [result] = await this.getPool().query<RowDataPacket[]>(
        `SELECT role, content, created_at FROM messages
         WHERE platform = ? AND chat_id = ? AND sender_id IN (?, ?)
         ORDER BY created_at DESC
         LIMIT ?`,
        [platform, chatId, senderId, 'bot', ConversationService.FETCH_LIMIT],
      );
      rows = result as Array<{ role: 'user' | 'assistant' | 'system' | 'summary'; content: string; created_at: Date }>;
    } catch (err) {
      this.logger.warn(`conversation history load failed; degrading to single-turn: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    if (rows.length === 0) return [];

    const surviving: ConversationTurn[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Soft /forget boundary: walker stops here. Boundary at i=0 means
      // the user's most-recent activity is a forget → empty history.
      if (row.role === 'system' && row.content === ConversationService.BOUNDARY_CONTENT) break;
      const ts = new Date(row.created_at).getTime();
      if (i === 0) {
        if (ts < now - ConversationService.SESSION_IDLE_MS) break;
      } else {
        const prevTs = new Date(rows[i - 1].created_at).getTime();
        if (ts < prevTs - ConversationService.SESSION_IDLE_MS) break;
      }
      surviving.push({ role: row.role, content: row.content });
    }

    surviving.reverse();

    if (options?.tokenBudget === undefined || options.tokenBudget <= 0) {
      return surviving;
    }

    const enriched = surviving.map(t => ({
      ...t,
      tokens: estimateTokens(t.content),
    }));
    let total = enriched.reduce((s, t) => s + t.tokens, 0);
    let keepFrom = 0;
    while (keepFrom < enriched.length - 1 && total >= options.tokenBudget) {
      total -= enriched[keepFrom].tokens;
      keepFrom++;
    }
    const trimmed = enriched.slice(keepFrom);
    if (keepFrom > 0) {
      this.logger.debug(
        `history trimmed: dropped ${keepFrom}/${enriched.length} turns (budget=${options.tokenBudget})`,
      );
    }
    return trimmed.map(({ tokens: _tokens, ...t }) => t);
  }

  /**
   * v0.6: drop-in replacement for loadHistory that adds sliding-window
   * summarization when enableSummarization=true and the surviving turn
   * set exceeds the token budget.
   *
   * Algorithm:
   *   1. Delegate to loadHistory for the baseline (boundary detection + FIFO).
   *   2. If summarization not enabled OR history fits in budget → return base.
   *   3. Otherwise: summarize the oldest non-summary turns, upsert the
   *      session's summary row (idempotent on summary-<hash> msg_id),
   *      and return [summary_turn, ...kept_verbatim_turns].
   *
   * Fail-open: a SummarizationUnavailableError thrown by the summarizer
   * propagates UP to MessageProcessor (NOT swallowed here).
   */
  async loadOrBuildHistory(
    platform: PlatformName,
    chatId: string,
    senderId: string,
    now: number,
    options?: { tokenBudget?: number; enableSummarization?: boolean },
  ): Promise<ConversationTurn[]> {
    const base = await this.loadHistory(platform, chatId, senderId, now, {
      tokenBudget: options?.tokenBudget,
    });

    if (!options?.enableSummarization) return base;
    if (base.length === 0) return base;

    // Find the latest summary row (if any), walking from the END of base
    // (which is in ascending time order after loadHistory's reverse()).
    let latestSummaryIdx = -1;
    for (let i = base.length - 1; i >= 0; i--) {
      if (base[i].role === 'summary') { latestSummaryIdx = i; break; }
    }
    const priorSummary = latestSummaryIdx >= 0 ? base[latestSummaryIdx] : null;
    const verbatimTurns = latestSummaryIdx >= 0
      ? [...base.slice(0, latestSummaryIdx), ...base.slice(latestSummaryIdx + 1)]
      : base;

    const budget = options?.tokenBudget ?? 0;
    const totalAfterPriorSummary = priorSummary
      ? estimateTokens(priorSummary.content) + verbatimTurns.reduce((s, t) => s + estimateTokens(t.content), 0)
      : verbatimTurns.reduce((s, t) => s + estimateTokens(t.content), 0);

    if (totalAfterPriorSummary <= budget) {
      // Under budget. Re-order so summary sits at index 0.
      if (priorSummary) return [priorSummary, ...verbatimTurns];
      return base;
    }

    // Over budget → summarize.
    const summarizerInput: ConversationTurn[] = priorSummary
      ? [
          { role: 'user', content: PREVIOUS_SUMMARY_HEADER + priorSummary.content },
          ...verbatimTurns,
        ]
      : verbatimTurns;
    const merged = await this.summarizer.summarize(summarizerInput, AbortSignal.timeout(15_000));
    // upsertSummary is fire-and-update; do not throw on failure.
    await this.messageLog.upsertSummary(merged, platform, chatId, senderId).catch((e) => {
      this.logger.warn(`upsertSummary failed; using in-memory summary for this turn: ${e instanceof Error ? e.message : String(e)}`);
    });

    // Keep as many recent turns as fit alongside the new summary within budget.
    const summaryTokens = estimateTokens(merged);
    const kept: ConversationTurn[] = [];
    let used = summaryTokens;
    for (let i = verbatimTurns.length - 1; i >= 0 && used <= budget; i--) {
      const t = verbatimTurns[i];
      const tTokens = estimateTokens(t.content);
      if (used + tTokens > budget) break;
      kept.unshift(t);
      used += tTokens;
    }
    // Edge case: if kept is empty AND summary tokens alone > budget, return summary anyway.
    // Caller (LlmHandler) renders it; spec §5 documents the degenerate case.
    return [{ role: 'summary', content: merged }, ...kept];
  }
}
