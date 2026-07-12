# Per-Model Token Budget — v0.5 Design Spec

**Date:** 2026-07-12
**Status:** Approved (pending spec review)
**Owner:** 徐鹏
**Target release:** v0.5.0
**Supersedes:** none
**Builds on:** v0.4.0 (token-budget truncation + `LlmProvider.contextWindow`)

---

## 1. Overview & Goals

v0.4.0 introduced a single global `HISTORY_TOKEN_BUDGET` (default `6000`) and laid the foundation for per-model tuning by exposing `readonly contextWindow: number` on every `LlmProvider`. v0.5 wires that foundation: the budget becomes **per-model** by default — derived from each provider's `contextWindow` — while preserving the v0.4 explicit-cap semantic so ops can still set a hard ceiling.

### Goals

- Default budget per request scales with the active model: `Math.floor(provider.contextWindow × HISTORY_BUDGET_RATIO)`. Default ratio `0.5` keeps half of every model's context reserved for system prompt, KB context, and the assistant reply.
- When `HISTORY_TOKEN_BUDGET` is set (any positive value, including the v0.4 default `6000`), the effective budget is `min(historyTokenBudget, contextWindow × ratio)` — explicit cap honored, per-model is the floor in spirit, but the smaller value always wins.
- When `HISTORY_TOKEN_BUDGET` is explicitly `0` (opt-out), v0.5 falls back to per-model only.
- `LlmHandler` exposes a single `contextWindow` accessor so `MessageProcessor` can derive the per-model budget without duplicating the `FallbackProvider` chain-head logic.
- Backwards-compatible: v0.4 callers that omit `HISTORY_BUDGET_RATIO` keep getting the v0.4 effective budget (`min(6000, contextWindow × 0.5)` on long-context models), which is *more conservative* than v0.4 default (which always used `6000` regardless of model). Documented in CHANGELOG.
- No DB migration, no schema change, no new DI service.

### Non-Goals (v0.5)

- Per-model overrides via `router_config` (still future; v0.5 ships the env-based foundation).
- Dynamic per-request tuning (e.g. per-user budget).
- Real-tokenizer integration (tiktoken, anthropic tokenizer).
- Sliding-window summarization, RAG over history, KB query expansion using history.
- Strict rejection when over budget (heuristic margin + 2k reserve cover typical content).

---

## 2. Architecture Overview

### 2.1 Decisions Recap

| Dimension | Choice |
|---|---|
| Budget source | `Math.floor(provider.contextWindow × HISTORY_BUDGET_RATIO)`, optionally min-capped by `HISTORY_TOKEN_BUDGET` when set > 0 |
| Default ratio | `HISTORY_BUDGET_RATIO = 0.5` (env-overridable; 0 < r ≤ 1; invalid → warn + 0.5) |
| Effective budget formula | `explicit = cfg.historyTokenBudget` (0 = unset). `effective = explicit > 0 ? min(explicit, floor(ctxWin * ratio)) : floor(ctxWin * ratio)` |
| Token counting | Unchanged from v0.4 (shared `estimateTokens` in `packages/shared`) |
| Truncation site | Unchanged from v0.4 (`ConversationService.loadHistory`) |
| Context-window source | `LlmHandler.contextWindow` getter → `provider.contextWindow` (v0.4 field) |
| Fallback chain head | `FallbackProvider.contextWindow` already returns `chain[0]?.contextWindow ?? 0` (v0.4 precedent) |
| New DI service | None. All changes live in existing modules. |
| Migration | None. |

### 2.2 Why this shape

- v0.4 already wired `LlmProvider.contextWindow` and `ConfigService.historyTokenBudget`. v0.5 is the connector: one new env, one accessor, one formula.
- The `min(explicit, perModel)` rule preserves v0.4's "set explicit cap → it wins" semantic (e.g. ops tightening a small-context model like Tongyi to `8000` retains the cap even though per-model default would also be `4000`).
- The `0 < r ≤ 1` validation: a ratio ≤ 0 disables trimming; a ratio > 1 leaves no room for system/KB/reply. Both fall back to `0.5` with a one-line startup warn so misconfigured deployments don't silently truncate to nothing.
- `Math.floor` keeps `tokenBudget` as an integer — `ConversationService` signature accepts `number` and treats fractional values the same as their floor, but integer is cleaner.
- No new DI service means no new seam for the recurring `useFactory` DI bug class (v0.2.0, v0.3.0). `LlmHandler.contextWindow` is a simple getter delegating to an existing field.

### 2.3 Module Structure

| Module | Status | Responsibility |
|---|---|---|
| `common/config` | MODIFIED | New `ConfigService.historyBudgetRatio` getter; validation + warn-log fallback |
| `handlers/llm/llm.handler` | MODIFIED | New `contextWindow` getter delegating to internal `LlmProvider` |
| `queue` (MessageProcessor) | MODIFIED | New `computeHistoryBudget()` private helper; called once per `process()` before `loadHistory` |
| `conversation`, `router`, `messages`, `admin-*` | unchanged | No impact |
| `handlers/llm/providers` (×5) | unchanged | `LlmProvider.contextWindow` already set in v0.4 |
| `shared` | unchanged | `estimateTokens` reused as-is |

---

## 3. Data Flow

### 3.1 Worker Flow (v0.5)

```
[Webhook controller]
  → messageLog.upsertUser(msg)              // v0.1.1
  → enqueueMessage(msg)                     // existing

[BullMQ Worker]
  → MessageProcessor.process(msg)
    1. const budget = this.computeHistoryBudget()       // NEW
         contextWindow   = handlers.llm.contextWindow
         ratio           = cfg.historyBudgetRatio
         perModelBudget  = Math.floor(contextWindow * ratio)
         explicitBudget  = cfg.historyTokenBudget      // 0 = unset
         budget          = explicitBudget > 0
                              ? Math.min(explicitBudget, perModelBudget)
                              : perModelBudget
    2. history = await conversationService.loadHistory(
         msg.platform, msg.chatId, msg.senderId,
         Date.now(),
         { tokenBudget: budget },                        // existing 5th arg
       )
    3. decision = router.route(msg, { history, ... })    // existing
    4. reply = dispatch(decision, msg, history, ...)     // existing
    5. messageLog.upsertAssistant(...)
    6. adapter.sendReply(...)
```

### 3.2 Compute-history-budget — pure helper

```
contextWindow  : number   // from LlmHandler.contextWindow
ratio          : number   // from ConfigService.historyBudgetRatio (validated 0<r≤1)
explicitBudget : number   // from ConfigService.historyTokenBudget (0=unset)

perModel       = Math.floor(contextWindow * ratio)
effective      = explicitBudget > 0
                  ? Math.min(explicitBudget, perModel)
                  : perModel

return effective
```

Read order: `cfg.historyTokenBudget` → `cfg.historyBudgetRatio` → `handlers.llm.contextWindow`. All three reads happen once per `process()` call (no caching). No allocations besides the floor/math helper.

### 3.3 Effective budget table (worked examples)

| Provider | contextWindow | ratio | perModel | explicit (`=6000`) | effective |
|---|---|---|---|---|---|
| Claude | 200000 | 0.5 | 100000 | 6000 | **6000** (cap wins) |
| OpenAI | 128000 | 0.5 | 64000 | 6000 | **6000** (cap wins) |
| Tongyi | 8000 | 0.5 | 4000 | 6000 | **4000** (perModel wins) |
| DeepSeek | 32000 | 0.5 | 16000 | 6000 | **6000** (cap wins) |
| Claude | 200000 | 0.5 | 100000 | 0 (unset) | **100000** (perModel only) |
| Tongyi | 8000 | 0.3 | 2400 | 0 (unset) | **2400** (perModel only) |
| any | any | 0 | 0 | 0 (unset) | **0** (disabled) |
| any | any | 0 | 0 | 6000 | **0** (ratio=0 disables perModel; explicit also 0 because of (0,0) precedence — see §5) |

The Tongyi row is the primary motivator for v0.5: under v0.4's flat `6000` budget, Tongyi's 8k context would routinely trim history down to a few short turns, then have only ~2k left for system+KB+reply, leaving very tight headroom. With v0.5's `min(6000, 4000) = 4000`, the trim is appropriately conservative for the actual model.

---

## 4. Component Details

### 4.1 `ConfigService.historyBudgetRatio` (NEW getter)

```ts
// apps/bot-core/src/common/config/config.service.ts
private static readonly DEFAULT_HISTORY_BUDGET_RATIO = 0.5;
private historyBudgetRatioWarned = false;

get historyBudgetRatio(): number {
  const raw = process.env.HISTORY_BUDGET_RATIO;
  if (raw === undefined) return ConfigService.DEFAULT_HISTORY_BUDGET_RATIO;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    if (!this.historyBudgetRatioWarned) {
      this.historyBudgetRatioWarned = true;
      this.logger.warn(
        `HISTORY_BUDGET_RATIO=${JSON.stringify(raw)} invalid; ` +
        `falling back to ${ConfigService.DEFAULT_HISTORY_BUDGET_RATIO}. ` +
        `Expected 0 < ratio ≤ 1.`,
      );
    }
    return ConfigService.DEFAULT_HISTORY_BUDGET_RATIO;
  }
  return n;
}
```

- `undefined` env → `0.5`. Garbage / ≤0 / >1 → `0.5` + one-time warn log (idempotent across calls in the same process).
- `r = 0` is treated as "disable per-model budget trimming" — `perModel = 0`, and the v0.4 precedence rule (`explicit > 0 ? min(...) : perModel`) means `effective` reduces to `min(explicit, 0)` or `0` respectively. Both paths land on trimming-disabled behavior. Documented in CHANGELOG.
- No DB lookup, no `router_config` read. One knob, one place.

### 4.2 `LlmHandler.contextWindow` (NEW accessor)

```ts
// apps/bot-core/src/handlers/llm/llm.handler.ts
get contextWindow(): number {
  return this.provider.contextWindow;
}
```

`this.provider` is already a field on `LlmHandler` (it owns the `FallbackProvider`, which exposes `contextWindow` per v0.4). One-line getter; no new dependency. For empty `FallbackProvider` chains, the underlying `provider.contextWindow === 0` (v0.4 precedent at `fallback.provider.ts`) — degenerate but not new.

### 4.3 `MessageProcessor.computeHistoryBudget()` (NEW private helper)

```ts
// apps/bot-core/src/queue/message.processor.ts
private computeHistoryBudget(): number {
  const contextWindow = this.handlers.llm.contextWindow;
  const ratio = this.cfg.historyBudgetRatio;
  const explicit = this.cfg.historyTokenBudget;       // existing v0.4 getter
  const perModel = Math.floor(contextWindow * ratio);
  return explicit > 0 ? Math.min(explicit, perModel) : perModel;
}
```

- Called once at the top of `process()`, just before `ConversationService.loadHistory(...)`.
- Pure / referentially transparent given the three inputs; easy to test in isolation with stubs.
- No new constructor arg — all three inputs are already in scope (`this.handlers.llm`, `this.cfg`).
- `Math.floor` keeps the value as an integer (ConversationService accepts fractional numbers equivalently, but cleaner).

### 4.4 `MessageProcessor.process()` (MODIFIED, 1-line change)

```ts
async process(msg: NormalizedMessage): Promise<ProcessResult> {
  const abortSignal = AbortSignal.timeout(30_000);

  let history: ConversationTurn[] = [];
  try {
    history = await this.conversation.loadHistory(
      msg.platform, msg.chatId, msg.senderId, Date.now(),
      { tokenBudget: this.computeHistoryBudget() },   // NEW: helper call (was this.config.historyTokenBudget)
    );
  } catch (err) {
    this.logger.warn(`loadHistory threw; degrading to empty history: ${...}`);
    history = [];
  }
  // ... rest unchanged
}
```

`MessageProcessor` constructor signature unchanged from v0.4 (still 6 args). No DI seam change. The 1-line change replaces the v0.4 inline `this.config.historyTokenBudget` with the new helper call.

### 4.5 Migrations

None. No schema changes in v0.5.

---

## 5. Failure Modes & Edge Cases

| Scenario | Behavior | Impact |
|---|---|---|
| `HISTORY_BUDGET_RATIO` unset | Default `0.5`. | Backwards compat with v0.4 deployments. |
| `HISTORY_BUDGET_RATIO=NaN` / `abc` / `-0.5` / `2` | Falls back to `0.5` + one-time warn log. | Defensive; one warn per process. |
| `HISTORY_BUDGET_RATIO=0` | `perModel = 0`; `effective` becomes `0` (explicit also 0 because `min(explicit, 0) = explicit`, but explicit is also `6000` by default... see next row) | If ops also unset `HISTORY_TOKEN_BUDGET=0`: trimming off. If `HISTORY_TOKEN_BUDGET` is its default `6000`: `min(6000, 0) = 0`, so trimming off regardless. Documented. |
| `HISTORY_TOKEN_BUDGET=0`, ratio unset | `explicit > 0` is false → returns `perModel = floor(ctxWin * 0.5)`. | Per-model only — v0.5's headline behavior. |
| `HISTORY_TOKEN_BUDGET=-1` or `abc` | v0.4 path: parses to invalid → `6000`. No v0.5 change here. | Backwards compat. |
| Both envs unset | `effective = floor(ctxWin * 0.5)`. Sensible default per model. | The "just works" deployment. |
| `LlmHandler.contextWindow = 0` (empty FallbackProvider chain) | `perModel = 0`. If `explicit > 0`, `effective = min(explicit, 0) = 0` → no trimming. If `explicit = 0`, `effective = 0` → no trimming. Same outcome either way: trim is disabled. | Degenerate case. Logs (debug) when `effective === 0` from `contextWindow === 0`. |
| MySQL down | v0.4 path: `loadHistory` throws → catch → `history = []`. No v0.5 change. | Unchanged. |
| Budget smaller than single newest turn | v0.4 path: newest always kept (loop guard in ConversationService). | Unchanged. |
| KB / Tool handler invocation | Doesn't read `ctx.history`. Unaffected by budget. | Unchanged. |
| Existing v0.4 callers/tests that read `cfg.historyTokenBudget` only | Continue to work. New getter is additive. | Backwards compat. |
| Whole-process race: ratio env mutated at runtime | Read on every `process()` call (no cache). | Same as v0.4. |

---

## 6. Testing Strategy

All tests are mock-based unit tests, no Docker (per `feedback_no_docker`).

### 6.1 New tests for `ConfigService.historyBudgetRatio`

| # | Case | Asserts |
|---|---|---|
| 1 | Env unset → `0.5` | Default path. |
| 2 | `HISTORY_BUDGET_RATIO=0.7` → `0.7` | Valid custom. |
| 3 | `HISTORY_BUDGET_RATIO=0` → `0` | `0` is parseable and validates to `false` for `<= 0` check; returns `0`. |
| 4 | `HISTORY_BUDGET_RATIO=-0.5` → `0.5` (with warn) | Negative invalid fallback. |
| 5 | `HISTORY_BUDGET_RATIO=2` → `0.5` (with warn) | Above-1 invalid fallback. |
| 6 | `HISTORY_BUDGET_RATIO=abc` → `0.5` (with warn) | Non-numeric invalid fallback. |
| 7 | Invalid env, called twice | Warn fires once (idempotent flag). |

### 6.2 New tests for `LlmHandler.contextWindow`

| # | Case | Asserts |
|---|---|---|
| 1 | Wraps a single `LlmProvider` | Returns `provider.contextWindow` directly. |
| 2 | Wraps a `FallbackProvider` with non-empty chain | Returns chain head's `contextWindow` (delegation). |
| 3 | Wraps a `FallbackProvider` with empty chain | Returns `0` (v0.4 precedent). |

### 6.3 New tests for `MessageProcessor.computeHistoryBudget`

| # | Case | Asserts |
|---|---|---|
| 1 | `explicit=6000`, `ratio=0.5`, `ctxWin=200000` → `min(6000, 100000) = 6000` | Explicit cap wins on long-context. |
| 2 | `explicit=6000`, `ratio=0.5`, `ctxWin=8000` → `min(6000, 4000) = 4000` | PerModel wins on small-context. Tongyi headline case. |
| 3 | `explicit=0`, `ratio=0.5`, `ctxWin=128000` → `64000` | Per-model only when explicit unset. |
| 4 | `explicit=0`, `ratio=0`, `ctxWin=200000` → `0` (no trimming) | Ratio=0 disables. |
| 5 | `explicit=6000`, `ratio=0.5`, `ctxWin=0` → `0` (no trimming) | Empty chain degenerate case. |
| 6 | Math.floor check: `ratio=0.5`, `ctxWin=200001` → `100000` (not `100000.5`) | Integer output. |

### 6.4 Pre-existing test updates

| File | Required change |
|---|---|
| `message.processor.test.ts` | The existing v0.4 test that asserted `loadHistory` called with `{ tokenBudget: cfg.historyTokenBudget }` (or similar direct budget pass-through) must be updated to assert the new helper's output instead. Mechanical — assert against a stubbed `cfg` + `handlers.llm` instead of calling through `computeHistoryBudget` directly. |
| `fallback.provider.test.ts` | The existing v0.4 test asserting `FallbackProvider.contextWindow === <head value>` (or `=== 0` for empty chain) is unchanged. |
| `message-processor.di.test.ts` (v0.4 canary) | Unchanged (MessageProcessor constructor signature unchanged). |

### 6.5 Whole-branch review at plan end (per `feedback_sdd_review_layering`)

Mandatory. v0.5 has one new seam and a few precision points:

- `computeHistoryBudget` reads 3 sources — confirm no caching/initialization order issue (none expected; all getters are stateless).
- New `LlmHandler.contextWindow` getter — confirm it doesn't break the existing `FallbackProvider` chain-head behavior under v0.4's `0`-on-empty-chain contract.
- `ConfigService.historyBudgetRatio` warn-flag `historyBudgetRatioWarned` is private instance state — confirm it doesn't leak across tests (jest reset between test files clears instances; in-process long-running lifetime is the same as any other logger pattern).
- The 1-line change in `MessageProcessor.process()` (replace inline `this.config.historyTokenBudget` with `this.computeHistoryBudget()`) — confirm no callsite accidentally still passes the old direct value.
- Recurring DI seam risk is **minimal** this wave (no constructor changes).

### 6.6 Manual e2e (out of scope, requires Docker)

- Tongyi deployment, default env: long conversation → trim lands at ~4 turns (instead of v0.4's ~6) and headroom for system+KB+reply is ~4k (up from ~2k).
- Claude deployment, env unset: long conversation → trim lands only when history exceeds `~100k` tokens (which never happens in practice).
- Set `HISTORY_TOKEN_BUDGET=1000` on Tongyi: trim lands at ~`min(1000, 4000) = 1000` tokens — explicit cap honored.
- Set `HISTORY_BUDGET_RATIO=0` + `HISTORY_TOKEN_BUDGET=0`: no trimming at all (v0.2/v0.3 behavior restored).

---

## 7. Out of Scope / Future Work

- **v0.6+ candidates:**
  - Per-model `history_token_budget_by_model` row in `router_config` (admin-tunable override per provider).
  - Real-tokenizer integration (tiktoken for OpenAI, anthropic tokenizer for Claude).
  - Sliding-window summarization when over budget.
  - KB query expansion using history.
  - Conversation analytics: histogram of dropped-turns-per-session, per-model history utilization.
  - Per-user retention / old-messages cleanup (from v0.2 spec §7).

- **Operational followups:**
  - Update `usage_log` to record the effective `history_token_budget` per call (observability for "did the per-model default kick in?").

---

## 8. Spec Self-Review

- **Placeholder scan:** All values exact (`0.5`, `200000`, `128000`, `8000`, `32000`, `6000`, `0`, `1`). No TBDs. Math.floor call site explicit.
- **Internal consistency:** Architecture ↔ data flow ↔ component details match. `computeHistoryBudget` reads the same three getters that are documented in §4.1 + §4.2 + §4.4.
- **Scope:** Single feature (per-model budget). One env var added (HISTORY_BUDGET_RATIO), one accessor added (LlmHandler.contextWindow), one helper added (computeHistoryBudget), one 1-line change in MessageProcessor.process(). No new services. No new module imports.
- **Ambiguity:**
  - "Per-model default" defined concretely via the formula table in §3.3.
  - "Explicit cap honored" defined concretely via the `min` rule.
  - "Invalid ratio" defined concretely as `NaN || ≤0 || >1`.
  - "Ratio=0" edge case documented explicitly in §5 (conservative: trimming off when explicit is also small).
  - "Empty FallbackProvider chain" degenerate case covered in §5.

---

*End of design.*
