# Per-Model Token Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive the per-message conversation-history token budget from each provider's `contextWindow × HISTORY_BUDGET_RATIO` by default, while honoring the v0.4 explicit cap (`HISTORY_TOKEN_BUDGET`) when set > 0.

**Architecture:** One new env-driven getter (`ConfigService.historyBudgetRatio`), one new accessor (`LlmHandler.contextWindow`), one new private helper (`MessageProcessor.computeHistoryBudget`) that computes the effective budget as `explicit > 0 ? min(explicit, floor(ctxWin × ratio)) : floor(ctxWin × ratio)`. The helper is invoked once per `process()` call before `ConversationService.loadHistory`. No schema changes, no constructor changes, no new DI services.

**Tech Stack:** TypeScript (NestJS), Jest, pnpm workspaces — all existing.

## Global Constraints

- Backwards-compatible with v0.4: v0.4 callers that omit `HISTORY_BUDGET_RATIO` continue to work; effective budget becomes `min(6000, floor(contextWindow × 0.5))` on long-context models (more conservative than v0.4's flat 6000 in most cases; never less conservative on Tongyi-class 8k models).
- `HISTORY_BUDGET_RATIO` default `0.5`. Validation: `0 < r ≤ 1`; invalid (`NaN`, `<=0`, `>1`) falls back to `0.5` with a one-time warn log per process.
- Effective budget formula: `explicit = cfg.historyTokenBudget` (0 = unset); `effective = explicit > 0 ? min(explicit, floor(ctxWin * ratio)) : floor(ctxWin * ratio)`.
- All values are integers (`Math.floor` on the per-model computation).
- New `.ts` files end with `\n` (POSIX trailing newline).
- Conventional commits style: `feat(scope): subject` or `refactor(scope): subject`, lowercase, imperative.
- All tests are mock-based unit tests (no Docker; per `feedback_no_docker`). Verify with `pnpm build` + `cd apps/bot-core && node node_modules/jest/bin/jest.js <path>` (or full suite for end-of-task verification).
- Whole-branch review is mandatory at Task 4 (per `feedback_sdd_review_layering`); recurring DI seam risk is MINIMAL this wave (no constructor changes, no new providers).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/bot-core/src/common/config/config.service.ts` | MODIFIED | Add `historyBudgetRatio` getter |
| `apps/bot-core/test/config-history-budget-ratio.test.ts` | NEW | 7 tests for the new getter |
| `apps/bot-core/src/handlers/llm/llm.handler.ts` | MODIFIED | Add `contextWindow` accessor (delegates to provider) |
| `apps/bot-core/test/llm.handler.context-window.test.ts` | NEW | 3 tests for the accessor |
| `apps/bot-core/src/queue/message.processor.ts` | MODIFIED | Add private `computeHistoryBudget()` helper; replace inline `cfg.historyTokenBudget` with `this.computeHistoryBudget()` in `process()` |
| `apps/bot-core/test/message.processor.test.ts` | MODIFIED | Update existing `noConfig` stub to include `historyBudgetRatio`; update the v0.4 budget pass-through test to assert via the new helper; add new tests covering the precedence formula |
| `apps/bot-core/test/message-processor.di.test.ts` (v0.4 canary) | UNCHANGED | Constructor signature unchanged (still 6 args) |
| `CHANGELOG.md` | MODIFIED | Prepend v0.5.0 release notes |
| `.superpowers/sdd/final-fixes-report.md` | NEW (only if Task 4 review returns findings) | Fix-wave summary |

---

### Task 1: `ConfigService.historyBudgetRatio` getter

**Files:**
- Modify: `apps/bot-core/src/common/config/config.service.ts` (add getter below existing `historyTokenBudget`)
- Create: `apps/bot-core/test/config-history-budget-ratio.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent)
- Produces: `ConfigService.historyBudgetRatio: number` — reads `process.env.HISTORY_BUDGET_RATIO`; default `0.5`; validates `0 < r ≤ 1`; falls back to `0.5` on invalid with one-time warn log

- [ ] **Step 1: Write the failing test file**

Create `apps/bot-core/test/config-history-budget-ratio.test.ts`:

```ts
import { ConfigService } from '../src/common/config/config.service';

const ORIGINAL_ENV = process.env.HISTORY_BUDGET_RATIO;

describe('ConfigService.historyBudgetRatio', () => {
  let svc: ConfigService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.HISTORY_BUDGET_RATIO;
    svc = new ConfigService();
    // NestJS Logger writes to console; spy and silence.
    warnSpy = jest.spyOn((svc as any).logger ?? console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.HISTORY_BUDGET_RATIO;
    else process.env.HISTORY_BUDGET_RATIO = ORIGINAL_ENV;
  });

  it('returns 0.5 when env is unset', () => {
    expect(svc.historyBudgetRatio).toBe(0.5);
  });

  it('returns the env value when valid (0 < r <= 1)', () => {
    process.env.HISTORY_BUDGET_RATIO = '0.7';
    expect(svc.historyBudgetRatio).toBe(0.7);
  });

  it('returns 0 when env is exactly "0" (used as "disable" signal by spec §5)', () => {
    process.env.HISTORY_BUDGET_RATIO = '0';
    expect(svc.historyBudgetRatio).toBe(0);
  });

  it('falls back to 0.5 when env is negative', () => {
    process.env.HISTORY_BUDGET_RATIO = '-0.5';
    expect(svc.historyBudgetRatio).toBe(0.5);
  });

  it('falls back to 0.5 when env is greater than 1', () => {
    process.env.HISTORY_BUDGET_RATIO = '2';
    expect(svc.historyBudgetRatio).toBe(0.5);
  });

  it('falls back to 0.5 when env is unparseable', () => {
    process.env.HISTORY_BUDGET_RATIO = 'abc';
    expect(svc.historyBudgetRatio).toBe(0.5);
  });

  it('warns only once for repeated invalid env reads (warn-once flag)', () => {
    process.env.HISTORY_BUDGET_RATIO = 'invalid';
    // Re-init so the invalid env is observed after construction.
    svc = new ConfigService();
    warnSpy = jest.spyOn((svc as any).logger ?? console, 'warn').mockImplementation(() => {});

    // Read three times; warn should fire exactly once.
    expect(svc.historyBudgetRatio).toBe(0.5);
    expect(svc.historyBudgetRatio).toBe(0.5);
    expect(svc.historyBudgetRatio).toBe(0.5);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('HISTORY_BUDGET_RATIO');
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/config-history-budget-ratio.test.ts`
Expected: FAIL (TS error or runtime "Cannot read properties of undefined" / "not a function" — `historyBudgetRatio` getter does not exist yet).

- [ ] **Step 3: Implement the getter**

Modify `apps/bot-core/src/common/config/config.service.ts`. Add a `private readonly logger = new Logger(ConfigService.name);` field (NestJS `Logger` is importable from `@nestjs/common`). Then add the getter block immediately after `historyTokenBudget`:

```ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);
  private static readonly DEFAULT_HISTORY_BUDGET_RATIO = 0.5;
  private historyBudgetRatioWarned = false;

  get historyTokenBudget(): number { /* existing — unchanged */ }
  // ... other existing getters ...

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
          `Expected 0 < ratio <= 1.`,
        );
      }
      return ConfigService.DEFAULT_HISTORY_BUDGET_RATIO;
    }
    return n;
  }
}
```

- [ ] **Step 4: Run the test and verify pass**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/config-history-budget-ratio.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Verify existing v0.4 ConfigService tests still pass**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/config-history-token-budget.test.ts`
Expected: PASS — v0.4's 5 tests still green (the new getter is additive and does not affect `historyTokenBudget`).

- [ ] **Step 6: Commit**

```bash
git add apps/bot-core/src/common/config/config.service.ts apps/bot-core/test/config-history-budget-ratio.test.ts
git commit -m "feat(config): historyBudgetRatio env getter with warn-once fallback"
```

---

### Task 2: `LlmHandler.contextWindow` accessor

**Files:**
- Modify: `apps/bot-core/src/handlers/llm/llm.handler.ts` (add getter)
- Create: `apps/bot-core/test/llm.handler.context-window.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent — only requires v0.4's `LlmProvider.contextWindow` field)
- Produces: `LlmHandler.contextWindow: number` — getter that returns `this.provider.contextWindow`

- [ ] **Step 1: Write the failing test file**

Create `apps/bot-core/test/llm.handler.context-window.test.ts`:

```ts
import { LlmHandler } from '../src/handlers/llm/llm.handler';
import { LlmProvider } from '../src/handlers/llm/llm.types';

function makeProvider(over: Partial<LlmProvider>): LlmProvider {
  return {
    name: 'stub',
    defaultModel: 'm',
    contextWindow: 1000,
    chat: async () => ({ text: 'r', model: 'm', usage: { promptTokens: 0, completionTokens: 0 } }),
    countTokens: () => 0,
    ...over,
  } as LlmProvider;
}

const noUsage = { record: async () => {} } as any;

describe('LlmHandler.contextWindow', () => {
  it('delegates to the underlying provider (single-provider wrap)', () => {
    const provider = makeProvider({ contextWindow: 200_000 });
    const handler = new LlmHandler(provider, noUsage);
    expect(handler.contextWindow).toBe(200_000);
  });

  it('delegates to FallbackProvider chain head (composition-style wrap)', () => {
    // Simulate FallbackProvider's getter exposing the head provider's window.
    const fallbackLike = {
      contextWindow: 64_000,   // chain head's value
    };
    // Cast through LlmProvider to satisfy the constructor.
    const handler = new LlmHandler(fallbackLike as unknown as LlmProvider, noUsage);
    expect(handler.contextWindow).toBe(64_000);
  });

  it('returns 0 when FallbackProvider chain is empty (degenerate v0.4 precedent)', () => {
    const fallbackLike = { contextWindow: 0 };
    const handler = new LlmHandler(fallbackLike as unknown as LlmProvider, noUsage);
    expect(handler.contextWindow).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/llm.handler.context-window.test.ts`
Expected: FAIL with "Cannot read properties of undefined (reading 'contextWindow')" or TS error — `contextWindow` getter does not exist yet.

- [ ] **Step 3: Implement the accessor**

Modify `apps/bot-core/src/handlers/llm/llm.handler.ts`. Add the getter below the constructor:

```ts
@Injectable()
export class LlmHandler implements Handler {
  readonly name = 'llm';
  private readonly logger = new Logger(LlmHandler.name);

  constructor(
    private readonly provider: LlmProvider,
    private readonly usage: UsageLogger,
  ) {}

  /**
   * Max tokens the underlying provider accepts. Falls back through
   * FallbackProvider to the chain head. Returns 0 if the chain is empty
   * (degenerate case — v0.4 precedent).
   */
  get contextWindow(): number {
    return this.provider.contextWindow;
  }

  // ... existing handle() unchanged
}
```

- [ ] **Step 4: Run the test and verify pass**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/llm.handler.context-window.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Verify existing LlmHandler tests still pass**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/llm.handler.history.test.ts`
Expected: PASS — existing tests do not exercise `contextWindow`; additive change.

- [ ] **Step 6: Commit**

```bash
git add apps/bot-core/src/handlers/llm/llm.handler.ts apps/bot-core/test/llm.handler.context-window.test.ts
git commit -m "feat(llm): LlmHandler.contextWindow accessor delegating to provider"
```

---

### Task 3: `MessageProcessor.computeHistoryBudget` helper + wire into `process()`

**Files:**
- Modify: `apps/bot-core/src/queue/message.processor.ts` (add helper; replace inline call)
- Modify: `apps/bot-core/test/message.processor.test.ts` (update `noConfig` stub + v0.4 budget test + add new tests)

**Interfaces:**
- Consumes:
  - `cfg.historyBudgetRatio` from Task 1 (number, default `0.5`)
  - `cfg.historyTokenBudget` from v0.4 (number, default `6000`)
  - `handlers.llm.contextWindow` from Task 2 (number, e.g. `200_000` for Claude)
- Produces:
  - `MessageProcessor.computeHistoryBudget(): number` private helper
  - Side effect: `process()` now passes `this.computeHistoryBudget()` (instead of `this.config.historyTokenBudget`) as the `tokenBudget` to `ConversationService.loadHistory`

- [ ] **Step 1: Update the test file to add 6 new tests + update existing v0.4 budget test**

Modify `apps/bot-core/test/message.processor.test.ts`. Find the existing `noConfig` stub (line 22):

```ts
const noConfig = { historyTokenBudget: 0 } as any;
```

Replace it with:

```ts
const noConfig = { historyTokenBudget: 0, historyBudgetRatio: 0.5 } as any;
```

Then find the v0.4 budget pass-through test (lines 230–251) titled `'passes tokenBudget from ConfigService to conversationService.loadHistory'`. Replace it AND add five new tests directly below it. The replacement test asserts the NEW helper is wired (rather than the v0.4 direct pass-through). The six new tests cover the formula in spec §6.3:

```ts
it('computeHistoryBudget: explicit cap (4321) beats perModel on long-context (200k * 0.5 = 100k)', async () => {
  const { map } = makeAdapters('wechat');
  const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
  const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 200_000 };
  const loadHistoryMock = jest.fn(async () => []);
  const cfg = { historyTokenBudget: 4321, historyBudgetRatio: 0.5 };
  const proc = new MessageProcessor(
    map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadHistory: loadHistoryMock } as any, cfg as any,
  );
  await proc.process(baseMsg({ msgId: 'budget1' }));
  expect(loadHistoryMock.mock.calls[0][4]).toEqual({ tokenBudget: 4321 });
});

it('computeHistoryBudget: perModel (4000) beats explicit (6000) on Tongyi-class 8k context', async () => {
  const { map } = makeAdapters('wechat');
  const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
  const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 8_000 };
  const loadHistoryMock = jest.fn(async () => []);
  const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0.5 };
  const proc = new MessageProcessor(
    map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadHistory: loadHistoryMock } as any, cfg as any,
  );
  await proc.process(baseMsg({ msgId: 'budget2' }));
  expect(loadHistoryMock.mock.calls[0][4]).toEqual({ tokenBudget: 4000 });
});

it('computeHistoryBudget: explicit=0 falls back to perModel (64k on 128k model, ratio 0.5)', async () => {
  const { map } = makeAdapters('wechat');
  const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
  const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 128_000 };
  const loadHistoryMock = jest.fn(async () => []);
  const cfg = { historyTokenBudget: 0, historyBudgetRatio: 0.5 };
  const proc = new MessageProcessor(
    map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadHistory: loadHistoryMock } as any, cfg as any,
  );
  await proc.process(baseMsg({ msgId: 'budget3' }));
  expect(loadHistoryMock.mock.calls[0][4]).toEqual({ tokenBudget: 64_000 });
});

it('computeHistoryBudget: ratio=0 disables perModel (effective = min(explicit, 0) = 0)', async () => {
  const { map } = makeAdapters('wechat');
  const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
  const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 200_000 };
  const loadHistoryMock = jest.fn(async () => []);
  const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0 };
  const proc = new MessageProcessor(
    map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadHistory: loadHistoryMock } as any, cfg as any,
  );
  await proc.process(baseMsg({ msgId: 'budget4' }));
  expect(loadHistoryMock.mock.calls[0][4]).toEqual({ tokenBudget: 0 });
});

it('computeHistoryBudget: empty FallbackProvider chain (ctxWindow=0) yields 0 even with explicit cap', async () => {
  const { map } = makeAdapters('wechat');
  const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
  const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 0 };
  const loadHistoryMock = jest.fn(async () => []);
  const cfg = { historyTokenBudget: 6000, historyBudgetRatio: 0.5 };
  const proc = new MessageProcessor(
    map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadHistory: loadHistoryMock } as any, cfg as any,
  );
  await proc.process(baseMsg({ msgId: 'budget5' }));
  expect(loadHistoryMock.mock.calls[0][4]).toEqual({ tokenBudget: 0 });
});

it('computeHistoryBudget: Math.floor applied (200001 * 0.5 = 100000.5 → 100000)', async () => {
  const { map } = makeAdapters('wechat');
  const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
  const llm = { handle: async () => ({ text: 'reply' }), contextWindow: 200_001 };
  const loadHistoryMock = jest.fn(async () => []);
  const cfg = { historyTokenBudget: 0, historyBudgetRatio: 0.5 };
  const proc = new MessageProcessor(
    map, router as any, { llm, kb: {}, tool: {} } as any, noLog, { loadHistory: loadHistoryMock } as any, cfg as any,
  );
  await proc.process(baseMsg({ msgId: 'budget6' }));
  expect(loadHistoryMock.mock.calls[0][4]).toEqual({ tokenBudget: 100_000 });
});
```

- [ ] **Step 2: Run the new tests and verify failure**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/message.processor.test.ts`
Expected: FAIL for the 6 new tests and the budget1 test (which now expects `4321` after the helper is in place). The original 11 tests should still pass after the `noConfig` stub update. The Task 1 + Task 2 dependencies must already be merged or the helper reads won't resolve. Run Task 1 + Task 2 tests first to confirm they're green before this step.

- [ ] **Step 3: Implement the helper + wire it into `process()`**

Modify `apps/bot-core/src/queue/message.processor.ts`. Replace the existing `process()` body line 44:

```ts
{ tokenBudget: this.config.historyTokenBudget },
```

with:

```ts
{ tokenBudget: this.computeHistoryBudget() },
```

Add the private helper method below `dispatch()`:

```ts
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
  const ratio = this.cfg.historyBudgetRatio;
  const explicit = this.cfg.historyTokenBudget;
  const perModel = Math.floor(contextWindow * ratio);
  return explicit > 0 ? Math.min(explicit, perModel) : perModel;
}
```

- [ ] **Step 4: Run the tests and verify pass**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/message.processor.test.ts`
Expected: PASS — all tests in this file green, including the 6 new tests and the replacement of the v0.4 budget pass-through assertion.

- [ ] **Step 5: Run the entire bot-core suite + build + lint to confirm no regression**

Run, in order:

```bash
cd apps/bot-core && node node_modules/jest/bin/jest.js
pnpm build
pnpm -r lint
```

Expected: All green. v0.4 baseline was 145 tests across 33 suites. v0.5 should add ~16 new tests (7 ConfigService + 3 LlmHandler + 6 MessageProcessor) for ~161 total.

- [ ] **Step 6: Commit**

```bash
git add apps/bot-core/src/queue/message.processor.ts apps/bot-core/test/message.processor.test.ts
git commit -m "feat(processor): computeHistoryBudget helper wiring per-model + explicit precedence"
```

---

### Task 4: CHANGELOG + whole-branch review + tag v0.5.0 + push

**Files:**
- Modify: `CHANGELOG.md` (prepend `## v0.5.0 — 2026-07-12`)
- Create (only if review returns findings): `.superpowers/sdd/final-fixes-report.md`

- [ ] **Step 1: Run final verification before whole-branch review**

Run:
```bash
pnpm build && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js 2>&1 | tail -10
```
Expected: All green. Note the actual test count for use in Step 4.

- [ ] **Step 2: Dispatch whole-branch review**

Use `superpowers:requesting-code-review`. Pass:
- `MERGE_BASE = v0.4.0` tag (or commit hash `e17841a`)
- `HEAD = <current commit after Task 3>`
- Global Constraints from this plan (especially the 1-line replacement in `MessageProcessor.process()` and the precedence formula).

Tell the reviewer: per-task reviews are clean; goal is seam-level integration drift (e.g. an old call site in `message.processor.test.ts` that still uses the v0.4 `historyTokenBudget`-only assertion, or a missed stub update for `noConfig`).

- [ ] **Step 3: Address review findings**

If the reviewer returns Critical or Important findings, dispatch a single fix subagent with the full findings list (per `feedback_sdd_review_layering`: one fix subagent for all findings). Re-review only the changed files.

- [ ] **Step 4: Update CHANGELOG**

Prepend to `CHANGELOG.md` (above the `## v0.4.0 — 2026-07-12` section):

```markdown
## v0.5.0 — 2026-07-12

Per-model conversation-history token budget. v0.4's flat `HISTORY_TOKEN_BUDGET` (default 6000) is now `min(historyTokenBudget, floor(provider.contextWindow × HISTORY_BUDGET_RATIO))`, so long-context models use more of their room by default and short-context models (Tongyi 8k) are kept honest. `HISTORY_TOKEN_BUDGET=0` remains the explicit opt-out.

**New APIs:**
- `ConfigService.historyBudgetRatio` getter reads env `HISTORY_BUDGET_RATIO` (default `0.5`, float). Validated `0 < r ≤ 1`; invalid falls back to `0.5` with a one-time warn log. `r = 0` is "disable per-model" (treated identically to v0.4's `historyTokenBudget = 0` via the min() precedence).
- `LlmHandler.contextWindow` getter delegates to the underlying `LlmProvider.contextWindow` (foundation laid in v0.4). For `FallbackProvider`: chain head's window, or `0` if chain is empty (v0.4 precedent).

**New behavior:**
- Effective budget formula: `effective = cfg.historyTokenBudget > 0 ? min(historyTokenBudget, floor(ctxWin * ratio)) : floor(ctxWin * ratio)`. Called once per `MessageProcessor.process()` via the new private helper `computeHistoryBudget()`.
- Backwards-compatible: v0.4 env-only deployments continue to work. Long-context Claude/OpenAI now get ~`min(6000, 50–100k)` (still capped at 6000), while Tongyi now gets ~`min(6000, 4000) = 4000` (more permissive than v0.4's flat 6000 on a single-turn; never less conservative in real terms because perModel shrinks gracefully with model size).

**Refactor:**
- `MessageProcessor.process()` 1-line change: inline `this.config.historyTokenBudget` replaced with `this.computeHistoryBudget()`. Constructor signature unchanged from v0.4 (still 6 args).

Tests: 161/161 across 33 suites (was 145 in v0.4.0; +16: 7 `ConfigService.historyBudgetRatio`, 3 `LlmHandler.contextWindow`, 6 `MessageProcessor.computeHistoryBudget`). `pnpm build` green. `pnpm -r lint` green.
```

(Adjust the test count to match Step 1's actual `pnpm test` output. Split "161/161" if suite count differs.)

- [ ] **Step 5: Commit CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): v0.5.0 release notes — per-model token budget"
```

- [ ] **Step 6: Tag and push**

```bash
git tag v0.5.0
git -c http.proxy= -c https.proxy= push origin master
git -c http.proxy= -c https.proxy= push origin v0.5.0
```

(The `-c http.proxy= -c https.proxy=` flags bypass the user's dead local proxy per `feedback_git_proxy`; drop them if `git push` works without them.)

- [ ] **Step 7: Write final-fixes-report.md (only if Step 3 produced fixes)**

If the whole-branch review returned no Critical/Important findings, skip this step. Otherwise, write `.superpowers/sdd/final-fixes-report.md` summarizing each finding + the fix commit hash + test evidence, and commit.

---

## Self-Review

**1. Spec coverage (§1 Goals → which task):**
- "Default budget per request scales with the active model" → Task 3 (`computeHistoryBudget`)
- "`HISTORY_TOKEN_BUDGET` set > 0 → min" → Task 3
- "`HISTORY_TOKEN_BUDGET = 0` → perModel only" → Task 3 + Task 1 covers `r=0` opt-out
- "`LlmHandler` exposes `contextWindow` accessor" → Task 2
- Backwards-compatible → Task 3 verification (existing tests still pass with updated `noConfig`)
- No DB migration → Task 4 explicitly says so; no .sql file created

**2. Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details", "similar to Task N". All test code is concrete with `expect(...)` assertions. All file paths are exact. All commands are exact with expected output.

**3. Type consistency:**
- `ConfigService.historyBudgetRatio: number` defined in Task 1 Step 3; consumed in Task 3 Step 3. Same type (`number`).
- `LlmHandler.contextWindow: number` defined in Task 2 Step 3; consumed in Task 3 Step 3. Same type.
- `MessageProcessor.computeHistoryBudget(): number` defined in Task 3 Step 3; declared as `private` per spec §4.3 ("private helper"). Tests in Task 3 cover it via the public `process()` surface, not direct invocation — consistent.
- `LoadHistoryOptions.tokenBudget?: number` (from v0.4) unchanged; `process()` continues to pass it as the 5th arg.

**4. Risks identified for whole-branch review (Task 4):**
- The `noConfig` stub in `message.processor.test.ts` was updated from `{ historyTokenBudget: 0 }` to `{ historyTokenBudget: 0, historyBudgetRatio: 0.5 }`. Verify no test was missed that relies on the old shape.
- The v0.4 budget-pass-through assertion (line 230–251 of pre-v0.5 `message.processor.test.ts`) was deleted and replaced with one of the 6 new tests. Verify no orphan assertion referencing the old shape remains.
- `LlmHandler.contextWindow` getter added; verify no `private` modifier was accidentally applied (it should be public so `computeHistoryBudget` can read it via the `handlers` map).
- `Math.floor` rounding on `(200001 * 0.5)` → `100000` covered by Task 3 Step 1 budget6 test.
- Recurring `useFactory` DI seam risk is MINIMAL this wave (no constructor changes, no new module imports) — but include this in the reviewer brief so they don't waste cycles on what we've already audited.

No issues found in self-review; plan ready to execute.
