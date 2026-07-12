# Token-Budget Truncation — v0.4 Design Spec

**Date:** 2026-07-12
**Status:** Approved (pending spec review)
**Owner:** 徐鹏
**Target release:** v0.4.0
**Supersedes:** none
**Builds on:** v0.3.1 (multi-turn context + `/forget`)

---

## 1. Overview & Goals

Replace the v0.2/v0.3 fixed `HISTORY_LIMIT = 10` turn cap on `ConversationService.loadHistory` with a **token-budget-aware** cap. The LLM handler always sees history bounded by token count rather than turn count, leaving predictable headroom for the system prompt, KB context, and user reply regardless of which provider is selected.

### Goals

- A single configurable token budget (default 6000) bounds `ctx.history` length in tokens.
- Budget is enforced at `ConversationService.loadHistory` time, so `LlmHandler` is unchanged.
- Per-provider context windows are exposed via `LlmProvider.contextWindow` for observability and future per-model tuning — but v0.4 ships with a single global budget.
- Heuristic token counting (no new dependencies, no tokenizer library). Acceptable ~20% error margin. The same heuristic also replaces the ASCII-only `countTokens` currently on every `LlmProvider` (CJK accuracy win, single source of truth).
- Backwards-compatible: `tokenBudget` is optional. Callers that omit it get the current behavior.

### Non-Goals (v0.4)

- Per-model budget overrides via `router_config` (foundation is laid via `contextWindow`, but the knob ships in a later release).
- Sliding-window summarization (v0.4+ candidate, scope creep).
- KB query expansion using history (separate feature).
- Per-provider tokenizer integration (tiktoken, anthropic tokenizer).
- Strict-budget rejection when over (we accept slight overshoot on pathological inputs and let the provider fall back).

---

## 2. Architecture Overview

### 2.1 Decisions Recap

| Dimension | Choice |
|---|---|
| Budget source | Single configurable constant `HISTORY_TOKEN_BUDGET` (default 6000) on `ConfigService` |
| Budget scope | Global, applies to all LLM providers in v0.4 |
| Token counting | Shared utility `estimateTokens(text)` in `packages/shared/src/token-estimate.ts`. CJK = 1 token/char; ASCII = 1 token per 4 chars; mixed = sum. |
| Truncation | Drop oldest whole turns (FIFO) until total ≤ budget; always keep ≥1 turn (the newest) |
| Where trimming lives | `ConversationService.loadHistory` (existing module, no new DI service) |
| LlmProvider shape | New `readonly contextWindow: number` field; existing `countTokens(text)` delegates to shared `estimateTokens` |
| LlmHandler | Unchanged |
| MessageProcessor | Gains `ConfigService` injection; passes `{ tokenBudget: cfg.historyTokenBudget }` to `loadHistory` |
| v0.2 N=10 hard cap | Removed; token budget supersedes. `FETCH_LIMIT = 20` SQL bound retained |

### 2.2 Why this shape

- `ConversationService` already filters history (30-min window walk + `/forget` boundary). Token budget is a third filter step in the same module. No new DI service = one fewer seam for the recurring `useFactory` bug class (v0.2.0, v0.3.0).
- Single global budget keeps `MessageProcessor` provider-agnostic. The handler may fall back across providers via `FallbackProvider`; pinning the budget per-provider would require resolving the chosen model before loadHistory runs.
- Centralizing `estimateTokens` in `packages/shared` means one source of truth. The four existing per-provider `countTokens` methods currently disagree on CJK (all of them underestimate — they use `Math.ceil(text.length / 4)`). Switching them to delegate fixes a real bug at zero scope cost.
- `LlmProvider.contextWindow` is the foundation for future per-model tuning but not the knob in v0.4. Ships with the field so adding `router_config.history_token_budget_by_model` later is a one-call change in `MessageProcessor`.

### 2.3 Module Structure

| Module | Status | Responsibility |
|---|---|---|
| `shared` | MODIFIED | New `estimateTokens(text)` in `packages/shared/src/token-estimate.ts` |
| `shared` | unchanged | `ConversationTurn` shape unchanged |
| `common/config` | MODIFIED | `ConfigService.historyTokenBudget` getter (env-overridable) |
| `conversation` | MODIFIED | `loadHistory` signature gains optional 5th arg `options?: LoadHistoryOptions`; import + use `estimateTokens` |
| `handlers/llm/llm.types` | MODIFIED | `LlmProvider` interface gains `readonly contextWindow: number` |
| `handlers/llm/providers` (×5) | MODIFIED | Each provider sets `contextWindow`; `countTokens` delegates to shared `estimateTokens` |
| `queue` (MessageProcessor) | MODIFIED | Injects `ConfigService`; passes `{ tokenBudget }` to `loadHistory` |
| `handlers/llm`, `handlers/kb`, `handlers/tool` | unchanged (LlmHandler interface use, not impl) | No impact |
| `router`, `messages`, `admin-*` | unchanged | No impact |

---

## 3. Data Flow

### 3.1 Worker Flow (v0.4)

```
[Webhook controller]
  → messageLog.upsertUser(msg)        // v0.1.1
  → enqueueMessage(msg)               // existing

[BullMQ Worker]
  → MessageProcessor.process(msg)
    1. const budget = this.config.historyTokenBudget   // NEW: 6000
    2. history = await conversationService.loadHistory(
         msg.platform, msg.chatId, msg.senderId,       // existing positional args
         Date.now(),
         { tokenBudget: budget },                       // NEW: 5th arg
       )
    3. decision = router.route(msg, { history, ... })   // existing
    4. reply = dispatch(decision, msg, history, ...)   // existing
    5. messageLog.upsertAssistant(...)
    6. adapter.sendReply(...)
```

### 3.2 Token-budget filter step (inside `loadHistory`, after the 30-min window walker + boundary check)

```
candidates = [...history rows from SQL, max FETCH_LIMIT=20]
                  ↓
           /forget boundary check (existing — break at first match)
                  ↓
           30-min window walk (existing)
                  ↓
           surviving[] (ascending order, time-bounded)
                  ↓
           if options?.tokenBudget === undefined OR <= 0:
               return surviving
                  ↓
           enriched[] = surviving.map(t => ({ ...t, tokens: estimateTokens(t.content) }))
                  ↓
           while keepFrom < enriched.length - 1 AND total > budget:
               total -= enriched[keepFrom].tokens
               keepFrom++
                  ↓
           return enriched.slice(keepFrom).map(({ tokens, ...t }) => t)   // strip tokens field
```

### 3.3 Token counting heuristic (single source of truth)

```ts
// packages/shared/src/token-estimate.ts
const CJK_RANGE = /[㐀-鿿぀-ゟ゠-ヿ　-〿가-힯]/;

export function estimateTokens(text: string): number {
  let cjk = 0, ascii = 0;
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk++;
    else ascii++;
  }
  return cjk + Math.ceil(ascii / 4);
}
```

Heuristic rationale: GPT-style BPE tokenizers assign roughly 1 token per 4 ASCII chars; CJK characters are often each their own token. This is approximate but adequate for budget enforcement given the proactive goal (leave headroom) and the existing 2k reserve.

### 3.4 Provider context windows

| Provider | Model | contextWindow |
|---|---|---|
| Claude | claude-3-5-sonnet-20241022 | 200000 |
| OpenAI | gpt-4o-mini | 128000 |
| Tongyi | qwen-turbo | 8000 |
| DeepSeek | deepseek-chat | 32000 |

These are declared per-provider in each provider's constructor. `FallbackProvider.contextWindow` returns its chain head's value (consistency with `defaultModel`).

---

## 4. Component Details

### 4.1 `estimateTokens` (NEW)

```ts
// packages/shared/src/token-estimate.ts
const CJK_RANGE = /[㐀-鿿぀-ゟ゠-ヿ　-〿가-힯]/;

export function estimateTokens(text: string): number {
  let cjk = 0, ascii = 0;
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk++;
    else ascii++;
  }
  return cjk + Math.ceil(ascii / 4);
}
```

Exported from `packages/shared/src/index.ts`. Used by `ConversationService.loadHistory` (budget filter) and by all 4 providers + fallback (replacing per-provider ASCII-only heuristic).

### 4.2 `ConfigService` (MODIFIED)

```ts
// apps/bot-core/src/common/config/config.service.ts
get historyTokenBudget(): number {
  const raw = process.env.HISTORY_TOKEN_BUDGET;
  if (raw === undefined) return 6000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 6000;
}
```

- Default 6000 = smallest current context window (Tongyi qwen-turbo 8k) − 2000 reserve for system+KB+reply.
- `undefined` env → 6000. Garbage / negative → 6000. Explicit `0` → 0 (disables budget).
- No DB lookup, no router_config read. One knob, one place. Easy to override in tests via `process.env.HISTORY_TOKEN_BUDGET`.

### 4.3 `LlmProvider` interface (MODIFIED)

```ts
// apps/bot-core/src/handlers/llm/llm.types.ts
export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly contextWindow: number;    // NEW: max tokens this provider accepts
  chat(req: ChatRequest): Promise<ChatResponse>;
  countTokens(text: string): number;  // existing — implementation updated to delegate to estimateTokens
}
```

Each provider's constructor sets `this.contextWindow`. Each provider's `countTokens` becomes `return estimateTokens(text);`. Tests assert both fields.

### 4.4 `ConversationService.loadHistory` (MODIFIED)

```ts
// apps/bot-core/src/conversation/conversation.service.ts
import { ConversationTurn, estimateTokens } from '@mpcb/shared';

export interface LoadHistoryOptions {
  tokenBudget?: number;     // undefined or <=0 = no budget enforcement (current behavior)
}

@Injectable()
export class ConversationService {
  // existing constants retained
  private static readonly FETCH_LIMIT = 20;
  private static readonly SESSION_IDLE_MS = 30 * 60 * 1000;
  private static readonly BOUNDARY_CONTENT = '__forget_boundary__';
  // HISTORY_LIMIT removed — token budget supersedes

  constructor(private readonly cfg: ConfigService) {}

  async loadHistory(
    platform: PlatformName,
    chatId: string,
    senderId: string,
    now: number,
    options?: LoadHistoryOptions,        // NEW (5th arg)
  ): Promise<ConversationTurn[]> {
    // ... existing SQL + boundary check + 30-min walker unchanged; produces `surviving: ConversationTurn[]`

    if (options?.tokenBudget === undefined || options.tokenBudget <= 0) {
      return surviving;
    }

    const enriched = surviving.map(t => ({
      ...t,
      tokens: estimateTokens(t.content),
    }));
    let total = enriched.reduce((s, t) => s + t.tokens, 0);
    let keepFrom = 0;
    while (keepFrom < enriched.length - 1 && total > options.tokenBudget) {
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
}
```

Notes:
- `HISTORY_LIMIT = 10` removed from constants; budget supersedes.
- Public `ConversationTurn` shape unchanged — `tokens` field is stripped before return.
- Boundary check + 30-min walk + budget filter are applied in that order (boundary first, since a forget always means drop everything).
- All 5 call sites that currently call `loadHistory(...)` must be updated to pass `options` (default `undefined` for backwards compat in tests that already exist).

### 4.5 `MessageProcessor` (MODIFIED)

```ts
// apps/bot-core/src/queue/message.processor.ts
import { ConfigService } from '../common/config/config.service';

@Injectable()
export class MessageProcessor {
  constructor(
    private readonly adapters: Map<PlatformName, PlatformAdapter>,
    private readonly router: RouterService,
    private readonly handlers: { llm: LlmHandler; kb: KbHandler; tool: ToolRegistry },
    private readonly messageLog: MessageLogService,
    private readonly conversation: ConversationService,
    private readonly config: ConfigService,    // NEW
  ) {}

  async process(msg: NormalizedMessage): Promise<ProcessResult> {
    const abortSignal = AbortSignal.timeout(30_000);

    let history: ConversationTurn[] = [];
    try {
      history = await this.conversation.loadHistory(
        msg.platform,
        msg.chatId,
        msg.senderId,
        Date.now(),
        { tokenBudget: this.config.historyTokenBudget },   // NEW
      );
    } catch (err) {
      this.logger.warn(`loadHistory threw; degrading to empty history: ${err instanceof Error ? err.message : String(err)}`);
      history = [];
    }
    // ... rest unchanged
  }
}
```

Note: `MessageProcessor` already takes 5 constructor args. Adding a 6th (`ConfigService`) is a typed-arg change. NestJS resolves `ConfigService` via the existing `ConfigModule` (which already registers it as `@Injectable()`). No `useFactory` workaround needed because `ConfigService`'s constructor takes no parameters — confirmed in §4.2. **Plan must verify** `MessageProcessorModule` (or wherever `MessageProcessor` is declared) lists `ConfigService` in `providers` or imports `ConfigModule`. If `ConfigService` is not currently in scope, the implementation must add the import — this is the recurring DI seam risk.

### 4.6 Concrete LLM providers (MODIFIED)

Each provider's constructor adds `this.contextWindow = <value>;`. Each provider's `countTokens` becomes `return estimateTokens(text);`. Example for Claude:

```ts
@Injectable()
export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  readonly defaultModel = 'claude-3-5-sonnet-20241022';
  readonly contextWindow = 200_000;
  // ...
  countTokens(text: string): number {
    return estimateTokens(text);
  }
}
```

`FallbackProvider.contextWindow` returns its chain head's value.

### 4.7 Migrations

None. No schema changes in v0.4.

---

## 5. Failure Modes & Edge Cases

| Scenario | Behavior | Impact |
|---|---|---|
| MySQL down | `loadHistory` throws → existing catch → `history = []` | Unchanged from v0.2/v0.3. |
| `HISTORY_TOKEN_BUDGET` env unset | Default 6000. | Backwards compat with v0.3.1 deployments. |
| `HISTORY_TOKEN_BUDGET=0` | No budget enforcement; current behavior preserved. | Opt-out path. |
| `HISTORY_TOKEN_BUDGET=-1` or `abc` | Parses to NaN/negative → falls back to 6000. | Defensive. |
| Budget = 6000, history = 50 turns × 1000 tokens | Walker drops 44 oldest, keeps 6 newest (totaling ~6000). | Predictable. Logged debug. |
| Budget smaller than single newest turn | Newest kept regardless (`keepFrom < enriched.length - 1` guard). Single-turn returned; logged debug if over budget. | Pathological input (1MB paste) accepted; provider falls back via existing chain. |
| `estimateTokens` underestimates by 30% (mixed CJK content where some chars tokenize as 2) | History slightly over budget in reality. Provider rejects with 400 → FallbackProvider chain. | Acceptable; 2k reserve + heuristic error margin cover typical content. |
| KB handler invocation | Doesn't read `ctx.history`. Unaffected. | No behavior change. |
| Tool handler invocation | Same as KB. | No behavior change. |
| `FallbackProvider.contextWindow` | Returns head provider's window. Future per-model budgets use this. | Consistent with existing `defaultModel` pattern. |
| `process.env.HISTORY_TOKEN_BUDGET` changed at runtime | Read on every `process()` call (no cache). | Simple; no admin-reload needed. |
| Existing callers of `loadHistory` (e.g., tests) | Must add 5th arg explicitly or get `undefined`. Backwards compatible. | Tests that use the old 4-arg signature keep working since `options` is optional. |
| `MessageProcessor` module registration | If `ConfigService` is not already in the module's scope, plan must add it. | Same DI risk as v0.3.0. Plan must verify. |
| `MessageProcessor` constructor grows to 6 args | Existing tests must update their `new MessageProcessor(...)` calls. | Mechanical fix; surface in plan. |

---

## 6. Testing Strategy

All tests are mock-based unit tests, no Docker (per `feedback_no_docker`).

### 6.1 New tests in `conversation.service.test.ts`

| # | Case | Asserts |
|---|---|---|
| 1 | History well under budget | All turns returned. |
| 2 | History over budget (mixed sizes) | Oldest turns dropped FIFO until ≤ budget; newest always preserved. |
| 3 | Single turn exceeds budget | Newest still returned; total > budget is logged debug. |
| 4 | CJK content via shared `estimateTokens`: 100 CJK chars = 100 tokens | Heuristic verified via ConversationService test. |
| 5 | ASCII content: 400 chars = 100 tokens | Heuristic verified. |
| 6 | Mixed CJK + ASCII | Sum of both heuristics. |
| 7 | 5th arg `options` undefined | No trimming (backwards compat with old 4-arg callers). |
| 8 | 5th arg `options.tokenBudget = 0` | No trimming. |
| 9 | 5th arg `options.tokenBudget = -1` | Treated as "no budget" (defensive). |
| 10 | Empty history + budget | Returns `[]`. |
| 11 | `ConversationTurn` shape preserved | Returned turns have no `tokens` field. |
| 12 | Boundary + budget interaction: `/forget` row breaks walker BEFORE budget filter | Walker returns empty; budget filter not reached. |

### 6.2 New tests for shared `estimateTokens` (in `packages/shared/test/`)

| # | Case | Asserts |
|---|---|---|
| 1 | Empty string → 0 | Edge case. |
| 2 | Pure CJK (100 chars) → 100 tokens | Range coverage. |
| 3 | Pure ASCII (400 chars) → 100 tokens | Range coverage. |
| 4 | Mixed CJK + ASCII | Sum. |
| 5 | Hiragana / Katakana / Hangul | Range coverage for non-CJK-Unified ranges. |

### 6.3 Updated tests

| File | New assertion |
|---|---|
| `config.service.test.ts` (or new `config-history-token-budget.test.ts`) | Env unset → 6000; `=12345` → 12345; `=0` → 0; `=-1` → 6000; `=abc` → 6000. |
| `claude.provider.test.ts` | `contextWindow === 200_000`; `countTokens('你好'.repeat(50))` returns 100 (was 25 with ASCII-only heuristic). |
| `openai.provider.test.ts` | `contextWindow === 128_000`; same `countTokens` CJK regression. |
| `tongyi.provider.test.ts` | `contextWindow === 8_000`. |
| `deepseek.provider.test.ts` | `contextWindow === 32_000`. |
| `fallback.provider.test.ts` | `contextWindow === <chain-head's value>`. |
| `message.processor.test.ts` | (a) `loadHistory` called with `{ tokenBudget: cfg.historyTokenBudget }` from `ConfigService`; (b) existing constructor calls updated to inject `ConfigService`. |

### 6.4 Test count

Baseline 115. New tests: 12 (`conversation.service`) + 5 (`estimateTokens` shared) + 5 (`config.historyTokenBudget`) + ~7 (`provider.contextWindow` + `countTokens` CJK regression × 5 files) + 1 (`message.processor` budget pass-through) = 30. New total: ~145. (Note: some existing tests will gain assertion lines, not new test cases — counted separately.)

### 6.5 Whole-branch review at plan end (per `feedback_sdd_review_layering`)

Mandatory. The recurring DI bug class is the main risk:
- `MessageProcessor` constructor gains `ConfigService` — verify NestJS resolves it cleanly (it should, since `ConfigService` takes no constructor args).
- Each provider's `LlmProvider` interface change — verify all 4 concrete providers + fallback implement the new `contextWindow` field (compile-time check, but worth a focused check that `FallbackProvider.contextWindow` doesn't return undefined).

### 6.6 Manual e2e (out of scope, requires Docker)

- Send 20 long messages → 21st sees only the last few (budget-trimmed).
- Set `HISTORY_TOKEN_BUDGET=500` → most turns dropped, only last short reply preserved.
- Send a 1MB paste → bot replies with single-turn context (newest turn only).
- Send a 100-CJK-char message → `countTokens` returns 100 (was 25 before v0.4).

---

## 7. Out of Scope / Future Work

- **v0.5+ candidates:**
  - Per-model `history_token_budget` in `router_config` (foundation laid via `LlmProvider.contextWindow`).
  - Real-tokenizer integration (tiktoken for OpenAI, anthropic tokenizer for Claude) for accurate counting.
  - Sliding-window summarization when over budget (separate feature).
  - KB query expansion using history.
  - Conversation-level analytics (per `v0.2 spec §7`).
  - Old-messages retention/cleanup.

- **Operational:**
  - `usage_log` token tracking should now include the trimmed-history length.
  - Admin observability: log histogram of dropped-turns-per-session.

---

## 8. Spec Self-Review

- **Placeholder scan:** All values exact (`6000`, `200000`, `128000`, `8000`, `32000`, `FETCH_LIMIT=20`, `SESSION_IDLE_MS=30*60*1000`, regex pattern verbatim). No TBDs.
- **Internal consistency:** Architecture matches data flow; data flow matches component details; component details match test plan. `ConversationTurn` shape unchanged in public interface; `tokens` field is internal-only. `LlmProvider` interface change is additive (new `contextWindow` field). `countTokens` behavior change (ASCII-only → CJK-aware) is a bug fix, not a breaking change.
- **Scope:** Single feature (token-budget truncation), single implementation plan, no decomposition needed. `estimateTokens` centralization and provider `countTokens` updates are required for consistency, not scope creep.
- **Ambiguity:** "Token budget" defined concretely. "Drop oldest turns" defined concretely. "Heuristic" defined concretely with code. "Always keep ≥1 turn" defined concretely via loop guard. `MessageProcessor` constructor change flagged as the recurring DI seam risk; plan must verify.

---

*End of design.*