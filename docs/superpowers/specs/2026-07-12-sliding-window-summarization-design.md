# Sliding-Window Summarization — v0.6 Design Spec

**Date:** 2026-07-12
**Status:** Approved (pending spec review)
**Owner:** 徐鹏
**Target release:** v0.6.0
**Supersedes:** none
**Builds on:** v0.5.0 (per-model token budget + `LlmProvider` + `MessageProcessor.computeHistoryBudget`)

---

## 1. Overview & Goals

v0.4.0 introduced a flat per-message token budget. v0.5.0 made it per-model. Both versions handle overflow by **dropping** oldest turns FIFO. v0.6 replaces that drop with a **summarize-and-retain** semantic: oldest turns are condensed into a single summary turn and returned alongside the most-recent verbatim turns. No history is silently lost; the small LLM-generated summary preserves key facts while fitting well under budget. A second `/forget` still restarts cleanly.

### Goals

- When `ENABLE_SUMMARIZATION=true` (default **off**), over-budget sessions preserve all prior context via a single running summary row, instead of dropping.
- Opt-in rollout: v0.4/v0.5 deployments continue to work unchanged when the flag is unset.
- Lazy trigger: summarization calls only happen when `loadHistory`'s surviving turns still exceed the budget; no-cost for short sessions.
- Incremental merge: a session's summary row is updated (not appended to) on each over-budget event, so the small LLM receives `prev_summary + new_turns` and is asked to compact, not append.
- Backwards-compatible: v0.5 callers that omit `enableSummarization` see v0.5 behavior identically.
- No new infrastructure (no new queue, no new worker, no new background service).
- One new migration (enum extension on `messages.role`).

### Non-Goals (v0.6)

- Per-model summarizer selection (one cheap-provider chain for all `ENABLE_SUMMARIZATION=true` sessions).
- Per-user opt-out (single global flag).
- Sliding-window summarization for KB and Tool handler invocations.
- Post-message background summarization (covered under Approach 3 in brainstorm; rejected for v0.6 to keep scope tight).
- Forgetting summary rows automatically (admin data retention / GDPR is separate work).
- Real-tokenizer integration for summarizer input (heuristic pre-trim, then small LLM; matches v0.5's no-real-tokenizer posture).

---

## 2. Architecture Overview

### 2.1 Decisions Recap

| Dimension | Choice |
|---|---|
| Overflow policy | Replace FIFO drop with summarize-and-retain; never silently drop (when feature on) |
| Summary source | Dedicated cheap-model `FallbackProvider` chain (`claude-haiku,openai-mini` by default) wrapped in `SummarizationService` |
| Summary storage | New row in `messages` table, `role='summary'` (enum extension); idempotent on `msg_id = summary-<sha1(sessionKey)>` |
| Trigger | Lazy: only when `loadHistory` surviving turns exceed `tokenBudget`. Incremental merge with prior summary row when one exists |
| Prompt shape | Summary delivered as a single `role: 'summary'` turn at the head of `ConversationTurn[]`. `LlmHandler` renders it as `role: 'user'` with a `[Earlier conversation summary]` prefix for provider compatibility |
| Default rollout | `ENABLE_SUMMARIZATION=false`. Opt-in |
| New infrastructure | None (reuses existing modules + a small new service) |
| Schema migration | One `ALTER TABLE` extending `messages.role` enum by `'summary'` |
| Fail-open | Summarizer throws → caller (`MessageProcessor`) catches → falls back to `loadHistory` only (v0.4/v0.5 behavior). User sees no difference for that message |
| `estimateTokens` | Unchanged |

### 2.2 Why this shape

- **Co-located with `ConversationService`.** `loadHistory` already owns the walker (boundary detection + 30-min idle gap + FIFO drop from v0.4). Adding a summarize-and-retain pass above it keeps the conversation-shape concern in one place; `MessageProcessor` stays single-line wired.
- **Dedicated cheap-provider chain.** Separates summarizer cost + model selection from main-call routing. Ops can tune `SUMMARIZER_PROVIDERS` independently. Reuses the existing `LlmProvider` interface and `FallbackProvider` composition.
- **Schema extension, not separate table.** `messages.role` enum is the canonical place to log conversation events (already holds `user|assistant|system`); widening to include `summary` reuses the walker and keeps query plans intact. The alternative (a separate `conversation_summaries` table) duplicates indexing and walker semantics.
- **Lazy + incremental merge.** Avoids background infra (Approach 3 in brainstorm). Each over-budget event costs one small LLM call; the small LLM's input is bounded by `summarizerContextWindow * 0.7`. Cost per session is approximately O(log n_overflows), not O(n_turns).
- **Single summary row per session.** `msg_id = summary-<sha1(platform+chatId+senderId)>` makes `ON DUPLICATE KEY UPDATE` collapse multiple summarize events into one row — no row accumulation, no truncation by `MEDIUMTEXT` size cap.
- **Render `role:'summary'` as `user` in LlmHandler.** Claude and OpenAI accept only `user|assistant|system`; mapping at render time avoids provider-specific code paths and keeps the `ConversationTurn` type honest about being multi-role.
- **Default off.** Summarization adds an LLM call (latency + cost) per over-budget event. Customers running small conversations should not pay for a feature they don't use. Opt-in flag gates the cost.

### 2.3 Module Structure

| Module | Status | Responsibility |
|---|---|---|
| `common/config` | MODIFIED | 3 new env-getters: `enableSummarization`, `summarizerProviderChain`, `summarizerContextWindow` |
| `handlers/summarizer/summarizer.handler` (and `.module`, `summarizer.service.ts`) | NEW | `SummarizationService.summarize(turns, signal)` — owns `FallbackProvider` chain, pre-trim guard, provider call, usage log |
| `handlers/summarizer/providers/{haiku,openai-mini,...}.provider.ts` | NEW | Provider impls configured for cheap-model APIs |
| `handlers/llm/llm.handler` | MODIFIED | Render `role: 'summary'` → `role: 'user'` with `[Earlier conversation summary]\n…` prefix |
| `conversation/conversation.service.ts` | MODIFIED | New `loadOrBuildHistory(...)` method. `ConversationTurn.role` union widens to include `'summary'`. Constructor gains 2 args (`SummarizationService`, `MessageLogService`) — first constructor change since v0.4 |
| `messages/message-log.service.ts` | MODIFIED | New `upsertSummary(content, sessionKey)` method, idempotent on `summary-<sha1>` `msg_id`. Propagates errors (parallels `upsertForgetBoundary`) |
| `migrations/0003_messages_summary_role.sql` | NEW | `ALTER TABLE messages MODIFY COLUMN role ENUM('user','assistant','system','summary') NOT NULL;` |
| `queue/message.processor.ts` | MODIFIED | 1-line wire: pass `enableSummarization: this.config.enableSummarization` into `loadOrBuildHistory`. Constructor unchanged |
| `shared` | unchanged | No new exports; `estimateTokens` reused |

---

## 3. Data Flow

### 3.1 Worker flow on a long conversation (v0.6, `ENABLE_SUMMARIZATION=true`)

```
[Webhook controller]
  → messageLog.upsertUser(msg)                          // v0.1.1
  → enqueueMessage(msg)                                 // existing

[BullMQ Worker]
  → MessageProcessor.process(msg)
    1. const opts = {
         tokenBudget:        this.computeHistoryBudget(),         // v0.5
         enableSummarization: this.config.enableSummarization,   // v0.6 NEW
       };
       history = await this.conversation.loadOrBuildHistory(
         msg.platform, msg.chatId, msg.senderId, now, opts,
       );
       // ConversationService.loadOrBuildHistory:
       //   a) base = await loadHistory(..., { tokenBudget })   // v0.4/v0.5 FIFO + boundary walker
       //   b) if (!opts.enableSummarization || base.length === 0) return base
       //   c) total = estimateTokensTotal(base)
       //   d) if (total <= budget) return base
       //   e) split: latestSummary = findLatestSummaryRow(base) || null
       //      olderTurns = base.filter(t => t !== latestSummaryRow)
       //   f) overflowTurns = olderTurns.oldestN(budget - summaryTokensNew)  // FIFO after summary
       //   g) newSummary = await summarizer.summarize(
       //        [latestSummary?.content ?? '', ...overflowTurnsAsUserText],
       //        signal,
       //      ).catch(e => throw new SummarizationUnavailableError(e));  // fail-open contract
       //   h) await messageLog.upsertSummary(newSummary, sessionKey)      // idempotent
       //      .catch(e => { warn; continue with in-memory summary; });
       //   i) kept = recentTurns(newSummary, budget, base)
       //   j) return [{ role: 'summary', content: newSummary }, ...kept]
    2. decision = router.route(msg, { history, ... })        // existing
    3. reply    = dispatch(decision, msg, history, ...)      // existing
                  // LlmHandler.handle maps role:'summary' → role:'user' with prefix
    4. messageLog.upsertAssistant(...)                       // existing
    5. adapter.sendReply(...)                                // existing
```

### 3.2 Effect of v0.6 on `usage_log`

`SummarizationService` records its own row in `usage_log` for each summarizer call:

```
usage_log row:
  user_id        = sender_id (numeric mapping or string fallback; same convention as main calls)
  provider       = 'claude-haiku' | 'openai-mini' | ...   // actual provider used by FallbackProvider
  model          = 'claude-haiku-4-5' | ...               // actual model returned
  prompt_tokens  = <reported by provider>
  completion_tokens = <reported by provider>
  cost_usd       = <recorded if available>
```

`MessageProcessor`'s main call is logged separately by `LlmHandler.usage` (existing). One inbound user message at over-budget state now produces **two** `usage_log` rows (one main + one summarizer). Captured for ops cost-monitoring.

### 3.3 Summary row identity (idempotency anchor)

```
sessionKey     = `${platform}::${chatId}::${senderId}`
sessionHash    = sha1(sessionKey) (hex, first 16 chars)
summaryMsgId   = `summary-${sessionHash}`
```

`ON DUPLICATE KEY UPDATE content = VALUES(content)` collapses multi-call merges into one row. Effect:

- First over-budget event → INSERT row. Subsequent over-budget events UPDATE the same row (incremental merge).
- After upgrade from v0.5→v0.6: zero rows of `role='summary'`. First over-budget event inserts the first row.
- Admin Messages page: surfaces the summary row alongside user/assistant; new filter `role=summary` to show only summaries.

---

## 4. Component Details

### 4.1 `ConfigService` new getters

```ts
// apps/bot-core/src/common/config/config.service.ts
get enableSummarization(): boolean {
  const raw = process.env.ENABLE_SUMMARIZATION;
  if (raw === undefined) return false;
  return /^(1|true|yes|on)$/i.test(raw);   // defensive: anything else = false
}

get summarizerProviderChain(): string[] {
  const raw = process.env.SUMMARIZER_PROVIDERS;
  if (raw === undefined || raw.trim() === '') {
    return ['claude-haiku', 'openai-mini'];
  }
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

get summarizerContextWindow(): number {
  const raw = process.env.SUMMARIZER_CONTEXT_WINDOW;
  if (raw === undefined) return 100_000;     // cheap-model safe default
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
}
```

- `enableSummarization`: default **off**. Only the documented truthy strings are `true`.
- `summarizerProviderChain`: provider-name strings. The string `'claude-haiku'` → `ClaudeHaikuProvider` (registered in `SummarizerModule`); unrecognized provider names fall back to `claude-haiku` (logged warn-once).
- `summarizerContextWindow`: cheap-model sensible default of 100k. Operators tune per model.

### 4.2 `SummarizationService`

```ts
// apps/bot-core/src/handlers/summarizer/summarizer.service.ts
@Injectable()
export class SummarizationService {
  private readonly logger = new Logger(SummarizationService.name);
  private summarizerAbortWarned = false;

  constructor(
    private readonly provider: LlmProvider,
    private readonly usage: UsageLogger,
  ) {}

  async summarize(turns: ConversationTurn[], signal: AbortSignal): Promise<string> {
    const inputCap = Math.floor(this.contextWindow * 0.7);   // pre-trim guard
    const prepared = preTrimToTokenBudget(turns, inputCap);
    const transcript = prepared.overflowTurns
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
    const priorBlock = prepared.priorSummaryTurn
      ? `PREVIOUS SUMMARY:\n${prepared.priorSummaryTurn.content}\n\nNEW TURNS TO MERGE:\n`
      : '';
    const req: ChatRequest = {
      model: this.provider.defaultModel,
      systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: priorBlock + transcript },
      ],
      signal,
    };
    try {
      const resp = await this.provider.chat(req);
      await this.usage.record({ ... }).catch(e => this.logger.warn(...));
      return resp.text.trim();
    } catch (err) {
      throw new SummarizationUnavailableError(err);
    }
  }

  get contextWindow(): number {
    return this.provider.contextWindow;
  }
}
```

(`turns` flattening reorders to a single user-content blob; the pseudo-render above is illustrative — final implementation flattens cleanly. Plan §4.5 spells this out.)

- **System prompt**: "Condense the following conversation into a single-paragraph summary. Preserve key facts, names, decisions, and questions asked. Drop pleasantries. Output plain prose, no bullet lists, no role labels."
- **`contextWindow`** getter parallels `LlmHandler.contextWindow` (v0.5 precedent).
- **Pre-trim guard**: drop oldest half of `overflowTurns` if total input exceeds 70% of `summarizerContextWindow`. Cheap, in-process, `estimateTokens`-based. Avoids provider-side errors and unbounded input cost.
- **`SummarizationUnavailableError`** is a typed error class in `packages/shared` (or local to summarizer module — final plan decides). Caller's `catch` falls back to `loadHistory` only.

### 4.3 `ConversationService.loadOrBuildHistory` (NEW method)

```ts
// apps/bot-core/src/conversation/conversation.service.ts
async loadOrBuildHistory(
  platform: PlatformName,
  chatId: string,
  senderId: string,
  now: number,
  options?: LoadHistoryOptions & { enableSummarization?: boolean },
): Promise<ConversationTurn[]> {
  const base = await this.loadHistory(platform, chatId, senderId, now, {
    tokenBudget: options?.tokenBudget,
  });
  if (!options?.enableSummarization) return base;          // v0.5 default path
  if (base.length === 0) return base;

  const latestSummary = [...base].reverse().find(t => t.role === 'summary');  // walker-aware: latest
  const summaryText = latestSummary?.content ?? '';
  const withoutSummary = base.filter(t => t !== latestSummary);
  const totalAfterSummary = estimateTokensTotal([{ role: 'user', content: summaryText }, ...withoutSummary]);
  const budget = options?.tokenBudget ?? 0;

  if (totalAfterSummary <= budget) {
    if (latestSummary) {
      // Re-order: [latest_summary, ...recent verbatim]
      return [latestSummary, ...withoutSummary];
    }
    return base;
  }

  // Over budget — pick oldest turns to fold into summary
  const overflowTurns = pickOldestOverflow(withoutSummary, summaryText, budget);
  const summarizerInput: ConversationTurn[] = [
    ...(summaryText ? [{ role: 'system', content: PREVIOUS_SUMMARY_HEADER + summaryText }] : []),
    ...overflowTurns,
  ];
  const merged = await this.summarizer.summarize(summarizerInput, AbortSignal.timeout(15_000));
  await this.messageLog.upsertSummary(merged, sessionKey(platform, chatId, senderId));
  const kept = pickKeptRecent(withoutSummary, merged, budget);
  return [{ role: 'summary', content: merged }, ...kept];
}
```

- Constructor signature change: `constructor(cfg, summarizer, messageLog)` (was `constructor(cfg)`). First constructor change since v0.4. The plan adds a `conversation.di.test.ts` canary to pin the new signature.
- New `ConversationTurn.role = 'user' | 'assistant' | 'system' | 'summary'`. Walker in `loadHistory` skips `'summary'` rows for boundary detection (no-op; boundary is on `'system'` content). Summary rows are returned by the walker like any other row, then handled by `loadOrBuildHistory`.
- `pickOldestOverflow` and `pickKeptRecent` are private helpers; both use `estimateTokens`.
- Summarizer failure → `SummarizationUnavailableError` propagates up to `MessageProcessor`. `loadOrBuildHistory` does NOT swallow.

### 4.4 `MessageLogService.upsertSummary` (NEW)

```ts
// apps/bot-core/src/messages/message-log.service.ts
async upsertSummary(content: string, sessionKey: string): Promise<void> {
  const [platform, chatId, senderId] = parseSessionKey(sessionKey);
  const msgId = `summary-${createHash('sha1').update(sessionKey).digest('hex').slice(0, 16)}`;
  await this.pool.query(
    `INSERT INTO messages (msg_id, platform, chat_id, sender_id, role, content)
     VALUES (?, ?, ?, ?, 'summary', ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content)`,
    [msgId, platform, chatId, senderId, content],
  );
}
```

- Propagates errors (`upsertForgetBoundary` precedent). Caller catches and decides degradation.
- Single-row anchor via `summary-${hash}` `msg_id`.

### 4.5 `LlmHandler.handle` — render `role: 'summary'`

```ts
// apps/bot-core/src/handlers/llm/llm.handler.ts
async handle(input, ctx) {
  const messages = [
    ...ctx.history.map(t =>
      t.role === 'summary'
        ? { role: 'user', content: `[Earlier conversation summary]\n${t.content}` }
        : t,
    ),
    { role: 'user', content: input.prompt },
  ];
  // ...rest unchanged
}
```

- Single mapping at render time. Provider-facing messages contain only `user|assistant` (and the user-content for the prior summary).
- All 5 existing `LlmProvider` impls (`Claude`, `OpenAI`, `Tongyi`, `DeepSeek`, `Fallback`) unchanged — they already accept `user|assistant`.

### 4.6 Schema migration `0003_messages_summary_role.sql`

```sql
-- v0.6: extend messages.role enum to allow 'summary' rows
ALTER TABLE messages
  MODIFY COLUMN role ENUM('user','assistant','system','summary') NOT NULL;

-- The existing index idx_messages_chat_time already covers the new value (role is not in the index).
-- No data migration required: existing rows are valid (they use only old enum values).
```

- MySQL 8 INSTANT DDL for enum extension — non-blocking on production tables.
- Reversible: `ALTER TABLE messages MODIFY COLUMN role ENUM('user','assistant','system') NOT NULL;` (left in a comment block of the migration, not run automatically).

### 4.7 `MessageProcessor.process` — 1-line wire

```ts
// apps/bot-core/src/queue/message.processor.ts
history = await this.conversation.loadOrBuildHistory(
  msg.platform, msg.chatId, msg.senderId, now,
  { tokenBudget: this.computeHistoryBudget(), enableSummarization: this.config.enableSummarization },
);
```

- Constructor signature unchanged (still 6 args). v0.5 DI canary at `message-processor.di.test.ts` continues to pass.
- `enableSummarization` defaults to `false` via `ConfigService.enableSummarization` getter when env unset.

---

## 5. Failure Modes & Edge Cases

| Scenario | Behavior | Impact |
|---|---|---|
| `ENABLE_SUMMARIZATION` unset/false | `loadOrBuildHistory` returns same as `loadHistory`. Zero behavior change. | Safe default — v0.5 deployments unaffected. |
| `SUMMARIZER_PROVIDERS` unset | Default chain `['claude-haiku', 'openai-mini']`. | Works without operator tuning. |
| Summarizer LLM call throws/times out | `SummarizationUnavailableError` propagates to `MessageProcessor`. MP catches → falls back to `loadHistory` only (v0.5 behavior). Logged warn with cause. | User sees no difference vs v0.5 for that message. Next message retries summarize. |
| Summarizer 15s inner `AbortSignal.timeout` | Distinct from the 30s outer `AbortSignal.timeout` in `MessageProcessor.process`. The 15s cap is `SummarizationService`'s own — fires first on slow provider. Outer catches it cleanly. | Bounded latency. |
| `messages` upsert fails | Logged warn → continue with in-memory summary in returned history (LLM still sees it this turn). Next turn retries the upsert. | Eventually consistent. Summary durable on next success. |
| Token budget `0` or unset | `loadOrBuildHistory` returns `loadHistory` output directly (no summarization work). | Backwards compat. |
| Session has zero rows | `loadHistory` returns `[]`; `loadOrBuildHistory` returns `[]`. | No work. |
| `/forget` issued, latest row is `__forget_boundary__` | Walker breaks at boundary (existing v0.3 behavior). `loadOrBuildHistory` returns `[]`. No summary against an empty history. Summary rows that exist BEFORE the boundary in DB are not returned (walker doesn't reach them). | `/forget` semantics preserved. |
| Two concurrent messages for same session | Both call `loadOrBuildHistory`. Both compute summaries on slightly different oldest-turns slices (race window). Both INSERT/UPDATE the same `msg_id`. Last-writer wins on the row content; both small LLM calls paid. Logged debug-level `"concurrent summarize on session"` on the second caller when overlap detected. | Acceptable waste. Rare under worker concurrency. Worst case: extra small LLM call per concurrent over-budget event. |
| `FallbackProvider` chain empty | `SummarizationService.summarize` throws (provider missing). `SummarizationUnavailableError` propagated. Caller falls back. | Operator misconfig → graceful fail-open to v0.5. |
| Summary content over time grows unbounded | `upsertSummary`'s `ON DUPLICATE KEY UPDATE` overwrites the row. Pre-trim guard in `SummarizationService` caps input size at ≤ 70% of `summarizerContextWindow`. Output also bounded (cheap-model output limits, plus the system prompt's "single-paragraph" instruction). | Bounded. |
| Existing `usage_log` rows | New summarizer calls add new rows; no schema change to `usage_log`. | Backwards compat. |
| `loadHistory`'s existing FIFO drop path | Still runs as the under-feature-off path. Under feature-on, FIFO still runs as the first pass; summarization only kicks in if even the post-FIFO result exceeds budget (rare by design). | Clean separation. |
| Provider API key missing for summarizer | `LlmProvider.chat` throws. Same as summarizer-throws row above. | Graceful fail-open. |
| MySQL down | `loadHistory` catch block already returns `[]`. `loadOrBuildHistory` returns `[]`. v0.2 behavior unchanged. | Backwards compat. |
| Schema migration on existing DB | `ALTER TABLE ... MODIFY` preserves existing rows. No data migration. | Safe upgrade. |

---

## 6. Testing Strategy

All tests are mock-based unit tests; no Docker (per `feedback_no_docker`).

### 6.1 New tests for `SummarizationService`

| # | Case | Asserts |
|---|---|---|
| 1 | Happy path: 6 turns → 1-paragraph summary (mock provider returns `"user asked about X, assistant explained Y"`). | Single LLM call with all 6 turns; usage logged via `UsageLogger.record`. |
| 2 | Pre-trim guard: 50 turns where total `estimateTokens` > 70% of `contextWindow` → oldest half pre-trimmed before provider call. | Provider sees ≤ 70% input; no provider-side error. |
| 3 | Provider throws → throws `SummarizationUnavailableError`. | Typed error class; original error in `.cause`. |
| 4 | AbortSignal: passed through to provider's chat call. | Cancel propagates. |

### 6.2 New tests for `ConversationService.loadOrBuildHistory`

| # | Case | Asserts |
|---|---|---|
| 1 | `enableSummarization=false` → delegates to `loadHistory`, identical output. | No summarizer call; no DB write. |
| 2 | Under-budget + no prior summary + `enableSummarization=true` → returns base verbatim. | No summarizer call. |
| 3 | Under-budget + prior summary row + `enableSummarization=true` → `[summary, ...recent]` (summary at index 0). | Re-order logic. |
| 4 | Over-budget + no prior summary → calls summarizer, upserts summary row, returns `[summary, ...kept]`. | New summary written; only kept-most-recent returned. |
| 5 | Over-budget + prior summary → incremental merge: summarizer receives `[priorSummary, ...overflowTurns]`. | Summarizer input includes prior content. |
| 6 | Summarizer throws → `loadOrBuildHistory` propagates `SummarizationUnavailableError`. | Does NOT silently fall back. |
| 7 | Upsert after summarize call fails → returns in-memory summary this turn. | Caller still gets a usable history. |
| 8 | `loadHistory` walker still breaks at `__forget_boundary__` even when summary rows precede the boundary in DB. | Boundary detection unaffected. |
| 9 | Empty session → returns `[]`. | No summarizer call. |

### 6.3 New tests for `MessageLogService.upsertSummary`

| # | Case | Asserts |
|---|---|---|
| 1 | Fresh insert with `msg_id = summary-<hash>`. | INSERT path; row persisted with `role='summary'`. |
| 2 | Re-call with same `sessionKey` → `ON DUPLICATE KEY UPDATE` updates the same row. No second row. | UPDATE path; row count stays at 1. |
| 3 | Pool error → error propagates (parallels `upsertForgetBoundary`). | Caller can catch and degrade. |

### 6.4 New tests for `LlmHandler` summary rendering

| # | Case | Asserts |
|---|---|---|
| 1 | Input history contains `role: 'summary'` → rendered as `role: 'user'` with `[Earlier conversation summary]\n…` prefix. | Provider sees only `user|assistant` roles. |
| 2 | History without summary → render unchanged. | No regression. |
| 3 | Usage log records the main call only; the summary call is recorded by `SummarizationService.usage` separately. | One log entry per call site. |

### 6.5 New tests for `ConfigService` env getters

| # | Case | Asserts |
|---|---|---|
| 1 | `ENABLE_SUMMARIZATION` unset → `false`. | Default-off. |
| 2 | `=true` / `=1` / `=yes` / `=on` → `true`. | Truthy only. |
| 3 | `=false` / `=0` / `=abc` → `false` (defensive). | Garbage → false. |
| 4 | `SUMMARIZER_PROVIDERS` unset → default `['claude-haiku','openai-mini']`. | Sensible default. |
| 5 | Custom chain: `claude-haiku,deepseek` → parsed as 2-element array. | Comma-list parsing. |
| 6 | `SUMMARIZER_CONTEXT_WINDOW=200000` → `200_000`. | Override parsed. |
| 7 | `SUMMARIZER_CONTEXT_WINDOW=abc` → falls back to `100_000` (defensive). | Garbage → default. |

### 6.6 New test — `conversation.di.test.ts` (DI canary)

| # | Case | Asserts |
|---|---|---|
| 1 | `ConversationService` constructs via `Test.createTestingModule(...).compile()` with the new `SummarizationService` injection. | The first constructor change since v0.4 is locked by an explicit DI seam test. Defense-in-depth per `feedback_sdd_review_layering`. |

### 6.7 Unchanged

All v0.5 tests untouched. Default-off guarantees zero regression for existing suites.

---

## 7. Out of Scope / Future Work

- **v0.7+ candidates:**
  - Per-model summarizer selection (a `router_config`-driven override).
  - Sliding-window attention over the `summary` row + recent turns in the prompt (vs treating summary as a single static turn).
  - Real-tokenizer summarizer input (tiktoken for OpenAI Haiku-class, anthropic for Claude).
  - Background post-message summarization (Approach 3 from brainstorm).
  - Summary retention policy / GDPR data retention.
  - Conversation analytics: histogram of summarize events per session, per-model summary compression ratio.

- **Operational followups:**
  - Grafana board for `usage_log` rows where `model LIKE 'claude-haiku%' OR ...` to track summarizer cost separately.
  - Logging "concurrent summarize on session" warning as an alert signal — frequent occurrence suggests worker concurrency should be reduced for sticky-session setups.

---

## 8. Spec Self-Review

- **Placeholder scan:** All values exact (`100_000`, `0.7`, `15_000`, `'claude-haiku'`, `'openai-mini'`, `ENABLE_SUMMARIZATION`, `SUMMARIZER_PROVIDERS`, `SUMMARIZER_CONTEXT_WINDOW`, `summary-<hex>`). No TBDs. Single-paragraph output instruction is a hard rule for the small model — documented.
- **Internal consistency:** Architecture ↔ data flow ↔ component details match. The single summary row anchor + incremental merge contract is described consistently across §3.3, §4.3, §4.4.
- **Scope:** Single feature (sliding-window summarization). 3 env vars added, 1 service added (with new module + providers), 1 method added, 1 schema migration, 1 wire change in `MessageProcessor`. The recurring DI-seam risk is the new `ConversationService` 1→2 arg constructor change — flagged + DI canary in §6.6.
- **Ambiguity:**
  - "Over budget" defined concretely: `total > tokenBudget` AND `enableSummarization=true` (§2.1, §3.1, §4.3).
  - "Incremental merge" defined concretely: prior summary content + new oldest turns → small LLM → row UPDATE (§2.2, §3.3, §4.3).
  - "Fail-open" defined concretely: `SummarizationUnavailableError` propagates from `loadOrBuildHistory` to `MessageProcessor`; MP catches + falls back to `loadHistory`-only path (§2.1, §4.2, §4.3, §5).
  - "Cheap model" defined concretely: `SUMMARIZER_PROVIDERS` env list defaults to `claude-haiku,openai-mini`; `SUMMARIZER_CONTEXT_WINDOW=100_000` default (§4.1).
  - "Rolling summary size" bounded by pre-trim guard at ≤ 70% of `summarizerContextWindow` and the "single-paragraph" output prompt (§4.2, §5).
  - The `/forget` interaction explicitly covered in §5.

---

*End of design.*
