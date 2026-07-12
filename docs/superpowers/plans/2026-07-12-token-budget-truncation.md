# Token-Budget Truncation — v0.4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v0.2/v0.3 fixed `HISTORY_LIMIT = 10` turn cap on `ConversationService.loadHistory` with a token-budget-aware cap that bounds history by estimated token count.

**Architecture:** A shared `estimateTokens` utility (CJK-aware heuristic) lives in `packages/shared` and is consumed by both `ConversationService.loadHistory` (for the budget filter) and each `LlmProvider.countTokens` (replacing the existing ASCII-only heuristic). A single `HISTORY_TOKEN_BUDGET` env var on `ConfigService` (default 6000) is read by `MessageProcessor` and passed as `{ tokenBudget }` to `loadHistory`. Each provider gains a `readonly contextWindow` field. The hard `HISTORY_LIMIT = 10` is removed.

**Tech Stack:** NestJS 10, TypeScript 5.3, Jest 29, mysql2/promise, existing module structure unchanged.

**Builds on:** v0.3.1 (multi-turn context + `/forget`).

## Global Constraints

- Token budget default: `6000` (= Tongyi qwen-turbo 8k context window − 2000 reserve for system+KB+reply).
- CJK heuristic: characters in `[㐀-鿿぀-ゟ゠-ヿ　-〿가-힯]` count as 1 token each; everything else uses `Math.ceil(chars / 4)`.
- Truncation strategy: drop oldest whole turns (FIFO) until total ≤ budget; always keep ≥ 1 turn (the newest).
- Filter ordering inside `loadHistory`: (1) `/forget` boundary break, (2) 30-min window walk, (3) token-budget filter.
- Per-provider context windows (declared in each provider's constructor): Claude = `200_000`, OpenAI = `128_000`, Tongyi = `8_000`, DeepSeek = `32_000`. `FallbackProvider.contextWindow` = chain head's value.
- Backwards compatibility: `loadHistory`'s 5th arg `options?` is optional; existing 4-arg callers and tests keep working unchanged.
- Validation: mock-based unit tests only (no Docker). `pnpm build`, `pnpm -r lint`, `pnpm test` all green before tag.
- Conventional commits, POSIX trailing newlines on all files.
- TDD throughout: failing test → verify fail → minimal impl → verify pass → commit.

---

### Task 1: Shared `estimateTokens` utility

**Files:**
- Create: `packages/shared/src/token-estimate.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './token-estimate';`)
- Create: `packages/shared/test/token-estimate.test.ts`

**Interfaces:**
- Produces: `export function estimateTokens(text: string): number` — counts tokens using the CJK-aware heuristic. CJK chars (range `㐀-鿿`, `぀-ゟ`, `゠-ヿ`, `　-〿`, `가-힯`) = 1 token each; ASCII = `Math.ceil(chars / 4)` tokens.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/token-estimate.test.ts`:

```ts
import { estimateTokens } from '../src/token-estimate';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts pure CJK as 1 token per character', () => {
    const text = '你好世界'.repeat(25); // 100 CJK chars
    expect(estimateTokens(text)).toBe(100);
  });

  it('counts pure ASCII as chars/4', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('counts ASCII with ceil rounding', () => {
    const text = 'abc'; // 3 chars → ceil(3/4) = 1
    expect(estimateTokens(text)).toBe(1);
  });

  it('counts mixed CJK + ASCII as sum of both heuristics', () => {
    const text = '你好' + 'hello'; // 2 CJK + 5 ASCII → 2 + ceil(5/4) = 2 + 2 = 4
    expect(estimateTokens(text)).toBe(4);
  });

  it('counts Hiragana as CJK', () => {
    const text = 'こんにちは'; // 5 Hiragana chars
    expect(estimateTokens(text)).toBe(5);
  });

  it('counts Katakana as CJK', () => {
    const text = 'カタカナ'; // 4 Katakana chars
    expect(estimateTokens(text)).toBe(4);
  });

  it('counts Hangul as CJK', () => {
    const text = '안녕하세요'; // 5 Hangul chars
    expect(estimateTokens(text)).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && node node_modules/jest/bin/jest.js test/token-estimate.test.ts -v`
Expected: FAIL — `Cannot find module '../src/token-estimate'` (or similar — module not yet exported).

- [ ] **Step 3: Create the utility**

Create `packages/shared/src/token-estimate.ts`:

```ts
const CJK_RANGE = /[㐀-鿿぀-ゟ゠-ヿ　-〿가-힯]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk++;
    else ascii++;
  }
  return cjk + Math.ceil(ascii / 4);
}
```

- [ ] **Step 4: Export from `packages/shared/src/index.ts`**

Replace the contents of `packages/shared/src/index.ts` with:

```ts
export * from './platform';
export * from './normalized-message';
export * from './normalized-reply';
export * from './route-decision';
export * from './token-estimate';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && node node_modules/jest/bin/jest.js test/token-estimate.test.ts -v`
Expected: PASS — all 8 tests pass.

- [ ] **Step 6: Verify full shared suite is still green**

Run: `cd packages/shared && node node_modules/jest/bin/jest.js -v`
Expected: PASS — 1 existing test (types.test.ts) + 8 new = 9 total.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/token-estimate.ts packages/shared/src/index.ts packages/shared/test/token-estimate.test.ts
git commit -m "feat(shared): add estimateTokens utility (CJK-aware heuristic)"
```

---

### Task 2: `ConfigService.historyTokenBudget` getter

**Files:**
- Modify: `apps/bot-core/src/common/config/config.service.ts` (add `historyTokenBudget` getter at the end of the class)
- Create: `apps/bot-core/test/config-history-token-budget.test.ts`

**Interfaces:**
- Produces: `ConfigService.historyTokenBudget: number` — reads `process.env.HISTORY_TOKEN_BUDGET`. Default `6000` when unset or invalid (`NaN`, negative, or unparseable). Explicit `0` is honored (disables budget).

- [ ] **Step 1: Write the failing test**

Create `apps/bot-core/test/config-history-token-budget.test.ts`:

```ts
import { ConfigService } from '../src/common/config/config.service';

const ORIGINAL_ENV = process.env.HISTORY_TOKEN_BUDGET;

describe('ConfigService.historyTokenBudget', () => {
  let svc: ConfigService;

  beforeEach(() => {
    delete process.env.HISTORY_TOKEN_BUDGET;
    svc = new ConfigService();
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.HISTORY_TOKEN_BUDGET;
    else process.env.HISTORY_TOKEN_BUDGET = ORIGINAL_ENV;
  });

  it('returns 6000 when env unset', () => {
    expect(svc.historyTokenBudget).toBe(6000);
  });

  it('returns the env value when valid positive integer', () => {
    process.env.HISTORY_TOKEN_BUDGET = '12345';
    expect(svc.historyTokenBudget).toBe(12345);
  });

  it('returns 0 when env is "0" (disables budget)', () => {
    process.env.HISTORY_TOKEN_BUDGET = '0';
    expect(svc.historyTokenBudget).toBe(0);
  });

  it('falls back to 6000 when env is negative', () => {
    process.env.HISTORY_TOKEN_BUDGET = '-1';
    expect(svc.historyTokenBudget).toBe(6000);
  });

  it('falls back to 6000 when env is unparseable', () => {
    process.env.HISTORY_TOKEN_BUDGET = 'abc';
    expect(svc.historyTokenBudget).toBe(6000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/config-history-token-budget.test.ts -v`
Expected: FAIL — `svc.historyTokenBudget is not a function`.

- [ ] **Step 3: Add the getter**

In `apps/bot-core/src/common/config/config.service.ts`, append the following getter at the end of the `ConfigService` class (after the existing `adminApiToken` getter, before the closing `}`):

```ts
  get historyTokenBudget(): number {
    const raw = process.env.HISTORY_TOKEN_BUDGET;
    if (raw === undefined) return 6000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 6000;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/config-history-token-budget.test.ts -v`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/bot-core/src/common/config/config.service.ts apps/bot-core/test/config-history-token-budget.test.ts
git commit -m "feat(config): add HISTORY_TOKEN_BUDGET env getter (default 6000)"
```

---

### Task 3: `LlmProvider.contextWindow` field + `countTokens` delegation

**Files:**
- Modify: `apps/bot-core/src/handlers/llm/llm.types.ts:39-44` (add `contextWindow` to interface)
- Modify: `apps/bot-core/src/handlers/llm/providers/claude.provider.ts` (add `contextWindow` field; replace `countTokens`)
- Modify: `apps/bot-core/src/handlers/llm/providers/openai.provider.ts` (same)
- Modify: `apps/bot-core/src/handlers/llm/providers/tongyi.provider.ts` (same)
- Modify: `apps/bot-core/src/handlers/llm/providers/deepseek.provider.ts` (same)
- Modify: `apps/bot-core/src/handlers/llm/fallback.provider.ts` (add `contextWindow` from chain head; replace `countTokens`)
- Modify: `apps/bot-core/test/fallback.provider.test.ts` (update mock providers to include `contextWindow`; add 1 new test)

**Interfaces:**
- Consumes: `estimateTokens(text)` from `@mpcb/shared` (Task 1)
- Produces: each `LlmProvider` now exposes `readonly contextWindow: number`. `LlmProvider.countTokens(text)` delegates to `estimateTokens(text)` from shared.

- [ ] **Step 1: Update `LlmProvider` interface**

In `apps/bot-core/src/handlers/llm/llm.types.ts`, replace the `LlmProvider` interface (lines 39-44) with:

```ts
export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly contextWindow: number;
  chat(req: ChatRequest): Promise<ChatResponse>;
  countTokens(text: string): number;
}
```

- [ ] **Step 2: Update mock providers in `fallback.provider.test.ts` to include `contextWindow`**

In `apps/bot-core/test/fallback.provider.test.ts`, the `ok` and `fail` helper functions at the top of the file must add `contextWindow: 8000`. Update both to:

```ts
const ok = (name: string, model = 'm') => ({
  name,
  defaultModel: model,
  contextWindow: 8000,
  chat: async () => ({ text: `${name}-ok`, usage: { promptTokens: 1, completionTokens: 1 }, model }),
  countTokens: () => 1,
});
const fail = (name: string, model = 'm') => ({
  name,
  defaultModel: model,
  contextWindow: 8000,
  chat: async () => { throw new Error(`${name}-down`); },
  countTokens: () => 1,
});
```

Also update the inline `finalProvider` mock in the "falls through to last model" test to add `contextWindow: 128000`:

```ts
const finalProvider = {
  name: 'openai',
  defaultModel: 'gpt-4o-mini',
  contextWindow: 128000,
  chat: async (req: any) => {
    lastSeen = req.model;
    return { text: 'final', usage: { promptTokens: 0, completionTokens: 0 }, model: req.model };
  },
  countTokens: () => 0,
};
```

- [ ] **Step 3: Run fallback provider tests to verify they fail**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/fallback.provider.test.ts -v`
Expected: FAIL — TypeScript compile error: `Property 'contextWindow' is missing in type ...` (because the interface now requires it and the concrete providers don't yet implement it).

- [ ] **Step 4: Update `ClaudeProvider`**

In `apps/bot-core/src/handlers/llm/providers/claude.provider.ts`:
1. Add `import { estimateTokens } from '@mpcb/shared';` near the top imports.
2. Add `readonly contextWindow = 200_000;` as a class field (after `readonly defaultModel = 'claude-3-5-sonnet-20241022';`).
3. Replace the `countTokens` method body with:

```ts
  countTokens(text: string): number {
    return estimateTokens(text);
  }
```

- [ ] **Step 5: Update `OpenAIProvider`**

In `apps/bot-core/src/handlers/llm/providers/openai.provider.ts`:
1. Add `import { estimateTokens } from '@mpcb/shared';` near the top.
2. Add `readonly contextWindow = 128_000;` after `readonly defaultModel: string;` (the field declaration in this provider is currently in the constructor — add a class-field declaration to match).
3. Replace the `countTokens` method body with:

```ts
  countTokens(text: string): number {
    return estimateTokens(text);
  }
```

- [ ] **Step 6: Update `TongyiProvider`**

In `apps/bot-core/src/handlers/llm/providers/tongyi.provider.ts`:
1. Add `import { estimateTokens } from '@mpcb/shared';` near the top.
2. Add `readonly contextWindow = 8_000;` after the `defaultModel` field declaration (this provider is a plain class, not `@Injectable()`).
3. Replace the `countTokens` method body with:

```ts
  countTokens(text: string): number {
    return estimateTokens(text);
  }
```

- [ ] **Step 7: Update `DeepSeekProvider`**

In `apps/bot-core/src/handlers/llm/providers/deepseek.provider.ts`:
1. Add `import { estimateTokens } from '@mpcb/shared';` near the top.
2. Add `readonly contextWindow = 32_000;` after `readonly defaultModel: string;`.
3. Replace the `countTokens` method body with:

```ts
  countTokens(text: string): number {
    return estimateTokens(text);
  }
```

- [ ] **Step 8: Update `FallbackProvider`**

In `apps/bot-core/src/handlers/llm/fallback.provider.ts`:
1. Add `import { estimateTokens } from '@mpcb/shared';` near the top.
2. Add `readonly contextWindow: number;` as a class field declaration.
3. In the constructor, after `this.defaultModel = chain[0]?.defaultModel ?? '';`, add:

```ts
    this.contextWindow = chain[0]?.contextWindow ?? 0;
```

4. Replace the `countTokens` method body with:

```ts
  countTokens(text: string): number {
    return estimateTokens(text);
  }
```

- [ ] **Step 9: Run fallback provider tests to verify they pass**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/fallback.provider.test.ts -v`
Expected: PASS — all 7 existing tests pass with the updated mock providers.

- [ ] **Step 10: Add a FallbackProvider.contextWindow test**

Append to `apps/bot-core/test/fallback.provider.test.ts` (at the end of the `describe('FallbackProvider', ...)` block):

```ts
  it('contextWindow mirrors the first provider in the chain', () => {
    const fb = new FallbackProvider([
      ok('tongyi', 'qwen-turbo'),
      ok('deepseek', 'deepseek-chat'),
      ok('openai', 'gpt-4o-mini'),
    ]);
    expect(fb.contextWindow).toBe(8000);
  });

  it('contextWindow is 0 when chain is empty (degenerate)', () => {
    const fb = new FallbackProvider([]);
    expect(fb.contextWindow).toBe(0);
  });
```

- [ ] **Step 11: Run full bot-core test suite to confirm no regressions**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js -v 2>&1 | tail -50`
Expected: PASS — baseline 115 tests plus the 2 new fallback tests. No other tests should regress (no other test currently constructs an `LlmProvider` instance without `contextWindow`).

- [ ] **Step 12: Commit**

```bash
git add apps/bot-core/src/handlers/llm/llm.types.ts \
        apps/bot-core/src/handlers/llm/providers/claude.provider.ts \
        apps/bot-core/src/handlers/llm/providers/openai.provider.ts \
        apps/bot-core/src/handlers/llm/providers/tongyi.provider.ts \
        apps/bot-core/src/handlers/llm/providers/deepseek.provider.ts \
        apps/bot-core/src/handlers/llm/fallback.provider.ts \
        apps/bot-core/test/fallback.provider.test.ts
git commit -m "feat(llm): add contextWindow field + delegate countTokens to shared estimateTokens"
```

---

### Task 4: `ConversationService.loadHistory` token-budget filter

**Files:**
- Modify: `apps/bot-core/src/conversation/conversation.service.ts` (extend signature, remove `HISTORY_LIMIT`, add filter logic, import `estimateTokens`)
- Modify: `apps/bot-core/test/conversation.service.test.ts` (add 12 new tests; existing tests must still pass without modification because the 5th arg is optional)

**Interfaces:**
- Consumes: `estimateTokens(text)` from `@mpcb/shared` (Task 1)
- Produces: `export interface LoadHistoryOptions { tokenBudget?: number; }` and updated signature `loadHistory(platform, chatId, senderId, now, options?: LoadHistoryOptions): Promise<ConversationTurn[]>`. When `options.tokenBudget` is undefined or `<= 0`, returns existing walker output unchanged. Otherwise drops oldest whole turns (FIFO) until total estimated tokens ≤ budget; always keeps ≥ 1 turn (the newest). `HISTORY_LIMIT = 10` removed.

- [ ] **Step 1: Write the failing tests**

Append to `apps/bot-core/test/conversation.service.test.ts` (inside the existing top-level `describe` block — read the file first to find the right spot; append before the final `});`):

```ts
  // ── Token-budget filter (v0.4) ────────────────────────────────────────

  describe('loadHistory token-budget filter', () => {
    const minute = 60_000;
    const now = Date.now();

    function rowsSpec(specs: Array<{ role: string; content: string; ageMin: number }>) {
      // Most-recent first (DESC), as the SQL returns them.
      return specs.map(s => ({
        role: s.role,
        content: s.content,
        created_at: new Date(now - s.ageMin * minute),
      }));
    }

    it('returns all turns when history is well under budget', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'hi', ageMin: 0 },
        { role: 'assistant', content: 'hello', ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 100_000 });
      expect(result).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);
    });

    it('drops oldest turns FIFO until total <= budget', async () => {
      // 4 turns, each 10 ASCII chars (≈3 tokens). Budget=6 → keep only the newest.
      // 'aaaaaaaaaa' (10 chars) → ceil(10/4) = 3 tokens.
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(10), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(10), ageMin: 0 },
        { role: 'user', content: 'c'.repeat(10), ageMin: 0 },
        { role: 'assistant', content: 'd'.repeat(10), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 6 });
      // Budget 6, each turn = 3 tokens. Keep newest only (always keep >=1).
      expect(result).toEqual([{ role: 'assistant', content: 'd'.repeat(10) }]);
    });

    it('keeps newest turn even if it alone exceeds budget', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(100), ageMin: 0 },       // 25 tokens
        { role: 'assistant', content: 'b'.repeat(100), ageMin: 0 },   // 25 tokens
        { role: 'user', content: 'c'.repeat(10000), ageMin: 0 },     // 2500 tokens
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 100 });
      // Total > budget but newest turn alone is kept.
      expect(result.length).toBe(1);
      expect(result[0].content).toBe('c'.repeat(10000));
    });

    it('CJK content counts as 1 token per character', async () => {
      const rows = rowsSpec([
        { role: 'user', content: '你'.repeat(100), ageMin: 0 }, // 100 tokens
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 50 });
      // 100 tokens > 50 budget; but only 1 turn → kept.
      expect(result.length).toBe(1);
      // Budget 150 fits.
      const { svc: svc2 } = makeService(async () => [rows]);
      const result2 = await svc2.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 150 });
      expect(result2.length).toBe(1);
    });

    it('mixed CJK + ASCII sums both heuristics', async () => {
      // '你好' + 'hello' = 2 CJK + 5 ASCII → 2 + ceil(5/4) = 4 tokens.
      const rows = rowsSpec([
        { role: 'user', content: '你好hello', ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 3 });
      // 4 tokens > 3; kept anyway (only 1 turn).
      expect(result.length).toBe(1);
      const { svc: svc2 } = makeService(async () => [rows]);
      const result2 = await svc2.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 4 });
      expect(result2.length).toBe(1);
    });

    it('does not trim when options is undefined (backwards compat)', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(1000), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(1000), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now);
      expect(result.length).toBe(2);
    });

    it('does not trim when tokenBudget is 0 (opt-out)', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(1000), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(1000), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 0 });
      expect(result.length).toBe(2);
    });

    it('does not trim when tokenBudget is negative (defensive)', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(1000), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: -1 });
      expect(result.length).toBe(1);
    });

    it('returns [] for empty history + budget', async () => {
      const { svc } = makeService(async () => [[]]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 6000 });
      expect(result).toEqual([]);
    });

    it('preserves ConversationTurn shape (no tokens field leaked)', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'hello', ageMin: 0 },
        { role: 'assistant', content: 'world', ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 1 });
      for (const turn of result) {
        expect(turn).toEqual({ role: expect.any(String), content: expect.any(String) });
        expect((turn as any).tokens).toBeUndefined();
      }
    });

    it('boundary check runs BEFORE budget filter (forget wins)', async () => {
      // Newest row is a /forget boundary → walker breaks, surviving is empty,
      // budget filter has nothing to do.
      const rows = rowsSpec([
        { role: 'system', content: '__forget_boundary__', ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 100_000 });
      expect(result).toEqual([]);
    });

    it('debug-logs when turns are dropped', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(10), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(10), ageMin: 0 },
        { role: 'user', content: 'c'.repeat(10), ageMin: 0 },
        { role: 'assistant', content: 'd'.repeat(10), ageMin: 0 },
      ]);
      const { svc, warnMock } = makeService(async () => [rows]);
      const debugMock = jest.fn();
      (svc as unknown as { logger: { warn: jest.Mock; debug: jest.Mock } }).logger.debug = debugMock;
      await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 6 });
      expect(debugMock).toHaveBeenCalledWith(expect.stringMatching(/history trimmed.*budget=6/));
    });
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/conversation.service.test.ts -v 2>&1 | tail -40`
Expected: FAIL — TS error: `Expected 4 arguments, but got 5` (because the existing `loadHistory` signature has 4 positional args).

- [ ] **Step 3: Update `ConversationService.loadHistory`**

In `apps/bot-core/src/conversation/conversation.service.ts`:

1. Replace the import line at the top:

```ts
import { PlatformName, estimateTokens } from '@mpcb/shared';
```

(Replace the existing `import { PlatformName } from '@mpcb/shared';` with the above.)

2. Remove the `HISTORY_LIMIT` constant from the class. The class constants become:

```ts
  private static readonly FETCH_LIMIT = 20;
  private static readonly SESSION_IDLE_MS = 30 * 60 * 1000;
  private static readonly BOUNDARY_CONTENT = '__forget_boundary__';
```

3. After the `ConversationTurn` interface (or near the top of the file), add:

```ts
export interface LoadHistoryOptions {
  tokenBudget?: number;
}
```

4. Replace the entire `loadHistory` method with:

```ts
  async loadHistory(
    platform: PlatformName,
    chatId: string,
    senderId: string,
    now: number,
    options?: LoadHistoryOptions,
  ): Promise<ConversationTurn[]> {
    let rows: Array<{ role: 'user' | 'assistant' | 'system'; content: string; created_at: Date }>;
    try {
      const [result] = await this.getPool().query<RowDataPacket[]>(
        `SELECT role, content, created_at FROM messages
         WHERE platform = ? AND chat_id = ? AND sender_id IN (?, ?)
         ORDER BY created_at DESC
         LIMIT ?`,
        [platform, chatId, senderId, 'bot', ConversationService.FETCH_LIMIT],
      );
      rows = result as Array<{ role: 'user' | 'assistant' | 'system'; content: string; created_at: Date }>;
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
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/conversation.service.test.ts -v 2>&1 | tail -40`
Expected: PASS — all existing tests (still passing with 4-arg signature) plus 12 new tests = 12 new + 13 existing = 25 total.

- [ ] **Step 5: Run full bot-core test suite to confirm no regressions**

Run: `pnpm --filter @mpcb/bot-core test 2>&1 | tail -30`
Expected: PASS — 115 baseline + 12 new = 127 tests (with the fallback tests from Task 3 added, expected 115 + 2 + 12 = 129).

- [ ] **Step 6: Commit**

```bash
git add apps/bot-core/src/conversation/conversation.service.ts apps/bot-core/test/conversation.service.test.ts
git commit -m "feat(conversation): token-budget filter in loadHistory (FIFO drop oldest)"
```

---

### Task 5: `MessageProcessor` integration — pass `tokenBudget` to `loadHistory`

**Files:**
- Modify: `apps/bot-core/src/queue/message.processor.ts` (add `ConfigService` constructor arg; pass `{ tokenBudget }` to `loadHistory`)
- Modify: `apps/bot-core/src/queue/worker.module.ts:onModuleInit` (pass `this.cfg` as 6th arg to `new MessageProcessor(...)`)
- Modify: `apps/bot-core/test/message.processor.test.ts` (update every `new MessageProcessor(...)` call to pass a `noConfig` stub; add 1 new test)

**Interfaces:**
- Consumes: `ConfigService.historyTokenBudget` (Task 2), `LoadHistoryOptions` (Task 4)
- Produces: `MessageProcessor` constructor now takes 6 args (added `ConfigService`). `process()` calls `loadHistory(..., { tokenBudget: this.config.historyTokenBudget })`.

- [ ] **Step 1: Write the failing test**

Append to `apps/bot-core/test/message.processor.test.ts` (at the end of the existing top-level `describe('MessageProcessor', ...)` block):

```ts
  it('passes tokenBudget from ConfigService to conversationService.loadHistory', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'reply' }) };
    const loadHistoryMock = jest.fn(async () => []);
    const conversation = { loadHistory: loadHistoryMock };
    const cfg = { historyTokenBudget: 4321 } as any;

    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation, cfg,
    );

    await proc.process(baseMsg({ msgId: 'm-budget', platform: 'wechat' }));

    expect(loadHistoryMock).toHaveBeenCalledTimes(1);
    const call = loadHistoryMock.mock.calls[0];
    expect(call[0]).toBe('wechat');          // platform
    expect(call[1]).toBe('c1');              // chatId
    expect(call[2]).toBe('u1');              // senderId
    expect(typeof call[3]).toBe('number');   // now
    expect(call[4]).toEqual({ tokenBudget: 4321 });
  });

  it('falls back to empty history when loadHistory throws (no tokenBudget leak)', async () => {
    const { map } = makeAdapters('wechat');
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'fallback' }) };
    const conversation = { loadHistory: async () => { throw new Error('mysql down'); } };
    const cfg = { historyTokenBudget: 6000 } as any;

    const proc = new MessageProcessor(
      map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation, cfg,
    );

    const result = await proc.process(baseMsg({ msgId: 'm-throw' }));
    expect(result.reply.text).toBe('fallback');
  });
```

Also, near the top of the file (next to the `noLog` / `noConversation` declarations), add:

```ts
  const noConfig = { historyTokenBudget: 0 } as any;
```

- [ ] **Step 2: Update every existing `new MessageProcessor(...)` call to add `noConfig` as the 6th arg**

Open `apps/bot-core/test/message.processor.test.ts`. Every existing `new MessageProcessor(map, router, handlers, noLog, noConversation)` call (there are 7 of them per the spec's review of the file) needs to become `new MessageProcessor(map, router, handlers, noLog, noConversation, noConfig)`. Run `grep -n "new MessageProcessor" apps/bot-core/test/message.processor.test.ts` first to enumerate, then edit each one.

- [ ] **Step 3: Run the updated test file to verify the existing tests fail (compile error on missing 6th arg)**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/message.processor.test.ts -v 2>&1 | tail -30`
Expected: FAIL — TS error: `Expected 6 arguments, but got 5`.

- [ ] **Step 4: Update `MessageProcessor`**

In `apps/bot-core/src/queue/message.processor.ts`:

1. Add to the imports near the top:

```ts
import { ConfigService } from '../common/config/config.service';
```

2. Update the constructor to add `config` as the 6th arg:

```ts
  constructor(
    private readonly adapters: Map<PlatformName, PlatformAdapter>,
    private readonly router: RouterService,
    private readonly handlers: { llm: LlmHandler; kb: KbHandler; tool: ToolRegistry },
    private readonly messageLog: MessageLogService,
    private readonly conversation: ConversationService,
    private readonly config: ConfigService,
  ) {}
```

3. Update the `loadHistory` call inside `process()` to pass `{ tokenBudget }`:

```ts
      history = await this.conversation.loadHistory(
        msg.platform,
        msg.chatId,
        msg.senderId,
        Date.now(),
        { tokenBudget: this.config.historyTokenBudget },
      );
```

- [ ] **Step 5: Update `WorkerModule` to pass `this.cfg` as the 6th arg**

In `apps/bot-core/src/queue/worker.module.ts`, find the `new MessageProcessor(...)` call inside `onModuleInit` and add `this.cfg` as the 6th arg:

```ts
    const processor = new MessageProcessor(
      adapterMap,
      this.router,
      { llm: this.llm, kb: this.kb, tool: this.tool },
      this.messageLog,
      this.conversation,
      this.cfg,
    );
```

- [ ] **Step 6: Run the test file to verify the new tests pass**

Run: `cd apps/bot-core && node node_modules/jest/bin/jest.js test/message.processor.test.ts -v 2>&1 | tail -30`
Expected: PASS — all 9 existing tests (now with 6 args) + 2 new tests = 11 total.

- [ ] **Step 7: Run full bot-core test suite to confirm no regressions**

Run: `pnpm --filter @mpcb/bot-core test 2>&1 | tail -20`
Expected: PASS — 115 baseline + 2 (fallback) + 12 (conversation) + 2 (processor) = 131 tests.

- [ ] **Step 8: Run `pnpm -r lint` and `pnpm build`**

Run: `pnpm -r lint 2>&1 | tail -10`
Expected: PASS — `tsc --noEmit` clean.

Run: `pnpm build 2>&1 | tail -10`
Expected: PASS — `nest build` (bot-core) + `tsc` (shared) clean.

- [ ] **Step 9: Commit**

```bash
git add apps/bot-core/src/queue/message.processor.ts \
        apps/bot-core/src/queue/worker.module.ts \
        apps/bot-core/test/message.processor.test.ts
git commit -m "feat(queue): MessageProcessor injects ConfigService + passes tokenBudget to loadHistory"
```

---

### Task 6: CHANGELOG + whole-branch review + tag v0.4.0 + push

**Files:**
- Modify: `CHANGELOG.md` (prepend `## v0.4.0 — 2026-07-12` section)
- Create: `.superpowers/sdd/final-review-report.md` (whole-branch review output)
- Create: `.superpowers/sdd/final-fixes-report.md` (fix-wave summary if any findings)

**Interfaces:** None — meta-task.

- [ ] **Step 1: Run final verification before whole-branch review**

Run: `pnpm build && pnpm -r lint && pnpm test 2>&1 | tail -10`
Expected: All green.

- [ ] **Step 2: Dispatch whole-branch review**

Use the `superpowers:subagent-driven-development` final-review dispatch (see `requesting-code-review/code-reviewer.md`). Pass:
- `MERGE_BASE = 49b0334` (current origin/master HEAD = v0.3.1)
- `HEAD = <current commit after Task 5>`
- Global Constraints from this plan (especially the recurring DI seam risk on `MessageProcessor` constructor change).

Tell the reviewer: per-task reviews are clean; the goal is to find seam-level integration drift (especially DI wiring in `WorkerModule.onModuleInit` after the 6-arg constructor change).

- [ ] **Step 3: Address review findings**

If the reviewer returns Critical or Important findings, dispatch a single fix subagent with the full findings list (per `feedback_sdd_review_layering`: one fix subagent for all findings, not one per finding). Re-review only the changed files.

- [ ] **Step 4: Update CHANGELOG**

Prepend to `CHANGELOG.md` (above the `## v0.3.1 — 2026-07-12` section):

```markdown
## v0.4.0 — 2026-07-12

Token-budget-aware truncation for conversation history.

- `ConversationService.loadHistory(platform, chatId, senderId, now, options?)` gains optional 5th arg `{ tokenBudget?: number }`. When set, drops oldest whole turns (FIFO) until total estimated tokens ≤ budget. Always keeps the most recent turn.
- New shared utility `estimateTokens(text)` in `@mpcb/shared` — CJK-aware heuristic (CJK chars = 1 token each; ASCII = `Math.ceil(chars / 4)`).
- `HISTORY_TOKEN_BUDGET` env var (default `6000`) on `ConfigService`. `MessageProcessor` reads it and passes to `loadHistory`. Set `0` to disable.
- `LlmProvider` interface gains `readonly contextWindow: number`. Per-provider values: Claude = `200_000`, OpenAI = `128_000`, Tongyi = `8_000`, DeepSeek = `32_000`. `FallbackProvider.contextWindow` = chain head's value.
- `LlmProvider.countTokens` now delegates to the shared `estimateTokens` (replaces per-provider ASCII-only heuristic that undercounted CJK content).
- `MessageProcessor` constructor gains `ConfigService` injection (5 → 6 args). `WorkerModule.onModuleInit` updated accordingly.
- Hard `HISTORY_LIMIT = 10` removed; token budget supersedes.
- Backwards-compatible: `loadHistory`'s `options` arg is optional; existing 4-arg callers and tests keep working.

Tests: 145/145 across 32 suites (was 115 in v0.3.1; +30: 8 estimateTokens, 5 ConfigService, 2 FallbackProvider, 12 ConversationService, 2 MessageProcessor, 1 misc). `pnpm build` green. `pnpm -r lint` green.
```

(Adjust the test count to match the actual `pnpm test` output for this branch. The baseline is 115; the spec projects 145. Verify by reading the test output. Use the actual number; the parenthetical breakdown is a placeholder — update if the per-task split differs.)

- [ ] **Step 5: Commit CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): v0.4.0 release notes — token-budget truncation"
```

- [ ] **Step 6: Tag and push**

```bash
git tag v0.4.0
git push origin master
git push origin v0.4.0
```

If `git push` fails with TLS/timeout errors, retry with `-c http.proxy= -c https.proxy=` per `feedback_git_proxy`:

```bash
git -c http.proxy= -c https.proxy= push origin master
git -c http.proxy= -c https.proxy= push origin v0.4.0
```

- [ ] **Step 7: Write final-fixes-report.md (only if Step 3 produced fixes)**

If the whole-branch review returned no findings, skip. Otherwise, write `.superpowers/sdd/final-fixes-report.md` summarizing each finding + the fix commit hash + test evidence, and commit.

---

## Self-Review

**1. Spec coverage:**
- §1 Goals — covered: budget config (Task 2), budget filter in ConversationService (Task 4), per-provider contextWindow (Task 3), heuristic counting (Task 1), backwards-compat (Tasks 3, 4, 5 keep 4-arg callers working).
- §2 Architecture — covered: no new DI service (Tasks 1-5 all extend existing modules), central estimateTokens (Task 1), LlmProvider interface change (Task 3).
- §3 Data flow — covered: `MessageProcessor.process` reads ConfigService.historyTokenBudget and passes to loadHistory (Task 5).
- §4 Components — all six sub-sections (§4.1–§4.6) have corresponding tasks (1, 2, 3, 4, 5, 3/4).
- §5 Failure modes — covered by tests in Tasks 1, 2, 4, 5 (empty history, env unset/0/-1/abc, single-turn > budget, boundary precedence).
- §6 Testing strategy — all 6.1–6.6 sub-sections have corresponding tasks (4, 1, 3/2/5, 5/6, 6).
- §7 Out of scope — none ship; future work noted in CHANGELOG.
- No gaps.

**2. Placeholder scan:**
- No "TBD", "TODO", "implement later", "fill in details", "similar to Task N".
- All test code is concrete (full `describe`/`it` blocks with `expect` assertions).
- All file paths are exact.
- All commands are exact with expected output.
- The test count in Task 6 Step 4 has a "(adjust if actual differs)" note — this is a meta-instruction, not a placeholder. Acceptable.
- The plan references `grep -n "new MessageProcessor"` in Task 5 Step 2 — explicit enumeration instruction. Acceptable.

**3. Type consistency:**
- `LoadHistoryOptions.tokenBudget?: number` defined in Task 4 Step 3 (added to conversation.service.ts); consumed in Task 4 Step 4 (filter logic), Task 5 Step 4 (MessageProcessor call). All references match.
- `ConfigService.historyTokenBudget: number` defined in Task 2 Step 3; consumed in Task 5 Step 4. All references match.
- `estimateTokens(text: string): number` defined in Task 1 Step 3; consumed in Tasks 3, 4. All references match.
- `LlmProvider.contextWindow: number` defined in Task 3 Step 1; set in Tasks 3 Steps 4-8 (each provider); asserted in Task 3 Step 10. All references match.
- `MessageProcessor` constructor signature: 5 args before (verified in existing code), 6 args after Task 5. All call sites updated (Task 5 Step 2 tests, Step 5 WorkerModule). No stale 5-arg calls remain.

**4. Risks identified for whole-branch review (Task 6):**
- `WorkerModule.onModuleInit` constructs `MessageProcessor` with `this.cfg` (already in scope) — should resolve cleanly, but worth verifying.
- All 5 `LlmProvider` implementors now have `contextWindow` — compile-time check.
- `FallbackProvider.contextWindow` returns `0` when chain is empty — degenerate case covered by Task 3 Step 10 test.

No issues found in self-review; plan ready to execute.

---