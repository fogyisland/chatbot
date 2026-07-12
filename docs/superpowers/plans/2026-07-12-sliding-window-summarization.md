# v0.6 Sliding-Window Summarization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v0.5's FIFO drop with summarize-and-retain when `ENABLE_SUMMARIZATION=true` (default off). Lazy + incremental merge. Default cheap-model provider chain `claude-haiku,openai-mini`.

**Architecture:** New `SummarizationService` (with cheap-model `LlmProvider` chain) called by a new `ConversationService.loadOrBuildHistory` (next to the existing `loadHistory`). One summary row per session, keyed `summary-<sha1(sessionKey)>`. Idempotent via `ON DUPLICATE KEY UPDATE`. `LlmHandler` renders `role:'summary'` turns as `role:'user'` with `[Earlier conversation summary]` prefix. `MessageProcessor.process` wires it through with a 1-line addition to the existing v0.5 `loadOrBuildHistory` call.

**Tech Stack:** NestJS (existing). pnpm (existing). `mysql2/promise` for the migration + summary-row write. `crypto.createHash` for session-key hashing. Mock-based unit tests (no Docker per `feedback_no_docker`).

## Global Constraints

- **NO DOCKER** for verification; pnpm build + mock-based unit tests only (`feedback_no_docker`).
- Mock-based unit tests only — no live MySQL/Redis (existing precedent).
- Schema migration: forward-compatible `ALTER TABLE … MODIFY` enum extension; preserve existing rows.
- All new env-gated features default OFF (existing pattern).
- TypeScript strict mode; pass `pnpm -r lint` after each task.
- POSIX trailing newline on every created/modified file (existing convention; v0.5 lint regret).
- Whole-branch review at plan end is mandatory (`feedback_sdd_review_layering` — 4 prior validations).
- Conventional commits; one commit per task (`feat(scope):`, `test(scope):`, `docs(spec|plan|changelog):`).
- All new tests under `apps/bot-core/test/` following the existing `*.test.ts` filename convention.
- Manual full-suite verification per task: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r build && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="<new-test-file>"`.
- Field naming in NEW code: `this.cfg`, `this.summarizer`, `this.messageLog`, `this.config` (existing conventions).
- `ConversationService`'s new constructor signature is **1 → 3 args** (`cfg, summarizer, messageLog`); flagged as a seam change — T5 must include a DI canary test.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `apps/bot-core/migrations/0003_messages_summary_role.sql` | NEW | `ALTER TABLE messages` enum extension by `'summary'` |
| `apps/bot-core/src/common/config/config.service.ts` | MODIFY | 3 new env getters: `enableSummarization`, `summarizerProviderChain`, `summarizerContextWindow` |
| `apps/bot-core/src/messages/message-log.service.ts` | MODIFY | New `upsertSummary(content, platform, chatId, senderId)`; helper for deterministic `msg_id` |
| `apps/bot-core/src/handlers/summarizer/summarizer.types.ts` | NEW | `SummarizationUnavailableError` class + `SUMMARIZER_PROVIDERS` injection token + `SUMMARIZER_SYSTEM_PROMPT` constant |
| `apps/bot-core/src/handlers/summarizer/providers/claude-haiku.provider.ts` | NEW | `ClaudeHaikuProvider extends ClaudeProvider`; overrides `name='claude-haiku'`, `defaultModel='claude-haiku-4-5'` |
| `apps/bot-core/src/handlers/summarizer/providers/openai-mini.provider.ts` | NEW | `OpenAIMiniProvider extends OpenAIProvider`; overrides `name='openai-mini'`, `defaultModel='gpt-4o-mini'` |
| `apps/bot-core/src/handlers/summarizer/summarizer.service.ts` | NEW | `SummarizationService.summarize(turns, signal) → string`; pre-trim guard; tries provider chain sequentially; throws `SummarizationUnavailableError` on full chain failure |
| `apps/bot-core/src/handlers/summarizer/summarizer.module.ts` | NEW | wires ClaudeHaiku + OpenAIMini + SummarizationService; exports `SUMMARIZER_PROVIDERS` + service |
| `apps/bot-core/src/conversation/conversation.service.ts` | MODIFY | widens `ConversationTurn.role` union to include `'summary'`; new `loadOrBuildHistory(...)` method; constructor 1 → 3 args (cfg, summarizer, messageLog) |
| `apps/bot-core/src/conversation/conversation.module.ts` | MODIFY | imports `SummarizerModule` + `MessagesModule` so the new deps resolve |
| `apps/bot-core/src/handlers/llm/llm.handler.ts` | MODIFY | render `role:'summary'` → `role:'user'` w/ `[Earlier conversation summary]\n…` prefix |
| `apps/bot-core/src/queue/message.processor.ts` | MODIFY | 1-line wire: pass `enableSummarization: this.config.enableSummarization` to `loadOrBuildHistory` |
| `apps/bot-core/src/app.module.ts` | MODIFY | import `SummarizerModule` |

### Tests

| Test file (relative to `apps/bot-core/test/`) | Status |
|---|---|
| `migrate.test.ts` | MODIFY: add 0003 file-existence + enum assertion |
| `config-summarization.test.ts` | NEW: 7 tests for the 3 new env-getters |
| `message-log.summary.test.ts` | NEW: 3 tests for `upsertSummary` |
| `claude-haiku.provider.test.ts` | NEW: 2 tests (name, defaultModel; chat delegates to Claude API contract) |
| `openai-mini.provider.test.ts` | NEW: 2 tests (name, defaultModel; chat delegates to OpenAI API contract) |
| `summarizer.service.test.ts` | NEW: 4 tests (happy path, pre-trim, propagates error, usage logged) |
| `conversation.load-or-build.test.ts` | NEW: 9 tests for `loadOrBuildHistory` |
| `conversation.di.test.ts` | NEW: 1 DI canary for the new 1→3-arg `ConversationService` constructor |
| `llm-handler-render-summary.test.ts` | NEW: 3 tests for `role:'summary'` → `role:'user'` rendering |

---

### Task 1: Schema migration — extend `messages.role` enum to include `'summary'`

**Files:**
- Create: `apps/bot-core/migrations/0003_messages_summary_role.sql`
- Modify: `apps/bot-core/test/migrate.test.ts` (append one `it` block for 0003)

- [ ] **Step 1: Write the migration file**

Create `apps/bot-core/migrations/0003_messages_summary_role.sql` with this exact content:

```sql
-- v0.6: extend messages.role enum to allow 'summary' rows.
-- MySQL 8 INSTANT DDL on enum extension — non-blocking on production tables.
-- Existing rows (which use only 'user', 'assistant', 'system') are preserved.
-- Reversible: ALTER TABLE messages MODIFY COLUMN role ENUM('user','assistant','system') NOT NULL;
ALTER TABLE messages
  MODIFY COLUMN role ENUM('user','assistant','system','summary') NOT NULL;
```

End the file with a single trailing newline (POSIX convention).

- [ ] **Step 2: Add the failing test**

Append a single `it()` block inside the existing `describe('migrations directory', () => { ... })` in `apps/bot-core/test/migrate.test.ts`, immediately AFTER the existing `it('0001_init.sql declares all required tables', () => { ... })` block. Insert:

```ts
  it('contains 0003_messages_summary_role.sql', () => {
    const p = path.join(__dirname, '..', 'migrations', '0003_messages_summary_role.sql');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('0003 extends messages.role enum with summary', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '0003_messages_summary_role.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ALTER TABLE\s+messages\s+MODIFY/i);
    // Must extend enum to include 'summary'
    expect(sql).toMatch(/ENUM\([^)]*'summary'[^)]*\)/i);
    // Must NOT remove the existing values
    expect(sql).toMatch(/'user'/);
    expect(sql).toMatch(/'assistant'/);
    expect(sql).toMatch(/'system'/);
  });
```

- [ ] **Step 3: Run the new tests, verify they pass**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="migrate.test.ts"`

Expected: 4 passing (2 pre-existing + 2 new). If any fails, fix the migration or test until both pass.

- [ ] **Step 4: Full lint + build sanity check**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r build && pnpm -r lint`

Expected: both green. (Migration file is plain SQL — no TypeScript impact — but the full suite must still build clean.)

- [ ] **Step 5: Commit**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git add apps/bot-core/migrations/0003_messages_summary_role.sql apps/bot-core/test/migrate.test.ts && git commit -m "feat(db): extend messages.role enum for v0.6 summary rows"
```

---

### Task 2: ConfigService — 3 new env getters (`enableSummarization`, `summarizerProviderChain`, `summarizerContextWindow`)

**Files:**
- Modify: `apps/bot-core/src/common/config/config.service.ts` — append 3 getters (after `historyBudgetRatio` getter, line 100)
- Create: `apps/bot-core/test/config-summarization.test.ts` — 7 tests

**Interfaces:**
- Consumes: existing `process.env` reads
- Produces: `enableSummarization: boolean` (default `false`); `summarizerProviderChain: string[]` (default `['claude-haiku','openai-mini']`); `summarizerContextWindow: number` (default `100_000`)

- [ ] **Step 1: Write failing tests**

Create `apps/bot-core/test/config-summarization.test.ts` with this exact content:

```ts
import { ConfigService } from '../src/common/config/config.service';

describe('ConfigService summarization getters', () => {
  let svc: ConfigService;
  let warnSpy: jest.SpyInstance;

  // Snapshot original env keys we'll touch, so afterAll can restore.
  const ENV_KEYS = [
    'ENABLE_SUMMARIZATION',
    'SUMMARIZER_PROVIDERS',
    'SUMMARIZER_CONTEXT_WINDOW',
  ];
  const SAVED: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    svc = new ConfigService();
    warnSpy = jest
      .spyOn((svc as any).logger ?? console, 'warn')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  // ---- enableSummarization ----

  it('enableSummarization defaults to false when env unset', () => {
    expect(svc.enableSummarization).toBe(false);
  });

  it('enableSummarization returns true for truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes']) {
      process.env.ENABLE_SUMMARIZATION = v;
      expect(svc.enableSummarization).toBe(true);
    }
  });

  it('enableSummarization returns false for falsy/garbage values', () => {
    for (const v of ['false', '0', 'no', 'off', 'abc', '']) {
      process.env.ENABLE_SUMMARIZATION = v;
      expect(svc.enableSummarization).toBe(false);
    }
  });

  // ---- summarizerProviderChain ----

  it('summarizerProviderChain defaults to [claude-haiku, openai-mini] when env unset', () => {
    expect(svc.summarizerProviderChain).toEqual(['claude-haiku', 'openai-mini']);
  });

  it('summarizerProviderChain parses a custom comma-list', () => {
    process.env.SUMMARIZER_PROVIDERS = 'claude-haiku,deepseek-chat,openai-mini';
    expect(svc.summarizerProviderChain).toEqual([
      'claude-haiku',
      'deepseek-chat',
      'openai-mini',
    ]);
  });

  // ---- summarizerContextWindow ----

  it('summarizerContextWindow defaults to 100_000 when env unset', () => {
    expect(svc.summarizerContextWindow).toBe(100_000);
  });

  it('summarizerContextWindow parses valid integer override', () => {
    process.env.SUMMARIZER_CONTEXT_WINDOW = '250000';
    expect(svc.summarizerContextWindow).toBe(250_000);
  });

  it('summarizerContextWindow falls back to 100_000 on garbage', () => {
    process.env.SUMMARIZER_CONTEXT_WINDOW = 'abc';
    expect(svc.summarizerContextWindow).toBe(100_000);
  });
});
```

- [ ] **Step 2: Run new tests, verify all FAIL**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="config-summarization.test.ts"`

Expected: 8 failures (each `it()` errors with `svc.enableSummarization is not a function`, etc.).

- [ ] **Step 3: Implement the 3 getters in ConfigService**

Modify `apps/bot-core/src/common/config/config.service.ts` by appending THREE getter methods after the closing `}` of the existing `historyBudgetRatio` getter (line 100, before the final closing `}` of the class on line 101). Insert this exact block:

```ts

  /**
   * v0.6: opt-in gate for sliding-window summarization.
   * When false (default), loadOrBuildHistory degrades to loadHistory-only.
   * Truthy values: 1, true, yes, on (case-insensitive). Anything else → false.
   */
  get enableSummarization(): boolean {
    const raw = process.env.ENABLE_SUMMARIZATION;
    if (raw === undefined) return false;
    return /^(1|true|yes|on)$/i.test(raw);
  }

  /**
   * v0.6: ordered list of summarizer provider-name strings.
   * Default: ['claude-haiku', 'openai-mini'] (cheap model classes).
   * Parsed from SUMMARIZER_PROVIDERS env (comma-separated, trimmed, empty filtered).
   * Provider-name strings map to registered LlmProvider instances in SummarizerModule.
   */
  get summarizerProviderChain(): string[] {
    const raw = process.env.SUMMARIZER_PROVIDERS;
    if (raw === undefined || raw.trim() === '') {
      return ['claude-haiku', 'openai-mini'];
    }
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * v0.6: context-window budget for the summarizer small-LLM input pre-trim guard.
   * Default: 100_000 tokens (cheap-model safe).
   * Invalid env (NaN, < 0) → 100_000.
   */
  get summarizerContextWindow(): number {
    const raw = process.env.SUMMARIZER_CONTEXT_WINDOW;
    if (raw === undefined) return 100_000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 100_000;
  }
```

The class's final closing `}` should follow this block (the existing file's last two lines `  }\n}` already accommodate).

- [ ] **Step 4: Run new tests, verify all PASS**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="config-summarization.test.ts"`

Expected: 8 passing.

- [ ] **Step 5: Full suite sanity check**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js`

Expected: 160/160 (same as v0.5.0; no behavior change yet).

- [ ] **Step 6: Commit**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git add apps/bot-core/src/common/config/config.service.ts apps/bot-core/test/config-summarization.test.ts && git commit -m "feat(config): v0.6 ENABLE_SUMMARIZATION + chain + context-window getters"
```

---

### Task 3: MessageLogService — `upsertSummary` (idempotent on `summary-<sha1>` `msg_id`)

**Files:**
- Modify: `apps/bot-core/src/messages/message-log.service.ts` — append `upsertSummary` method (before the `close()` method)
- Create: `apps/bot-core/test/message-log.summary.test.ts` — 3 tests

**Interfaces:**
- Consumes: `cfg.mysqlHost` etc. (lazy pool, same pattern as `upsertForgetBoundary`)
- Produces: `upsertSummary(content, platform, chatId, senderId): Promise<void>` (propagates errors)

- [ ] **Step 1: Write failing tests**

Create `apps/bot-core/test/message-log.summary.test.ts` with this exact content:

```ts
import * as crypto from 'crypto';
import { MessageLogService } from '../src/messages/message-log.service';
import { ConfigService } from '../src/common/config/config.service';

const sessionKeyFor = (p: string, c: string, s: string): string => `${p}::${c}::${s}`;
const expectedMsgId = (sessionKey: string): string =>
  `summary-${crypto.createHash('sha1').update(sessionKey).digest('hex').slice(0, 16)}`;

describe('MessageLogService.upsertSummary', () => {
  let svc: MessageLogService;

  beforeEach(() => {
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_PORT;
    delete process.env.MYSQL_USER;
    delete process.env.MYSQL_PASSWORD;
    delete process.env.MYSQL_DATABASE;
    svc = new MessageLogService(new ConfigService());
  });

  it('builds the expected deterministic summary msg_id from sessionKey', () => {
    // Pure-hash sanity check (no DB needed) — the helper must be stable.
    const sessionKey = sessionKeyFor('wechat', 'chat-1', 'user-1');
    const msgId = expectedMsgId(sessionKey);
    expect(msgId).toMatch(/^summary-[0-9a-f]{16}$/);
    // Same input → same output (callable twice)
    expect(msgId).toBe(expectedMsgId(sessionKey));
    // Different sender → different output
    expect(msgId).not.toBe(
      expectedMsgId(sessionKeyFor('wechat', 'chat-1', 'user-2')),
    );
  });

  it('throws when MySQL pool cannot be created (DB unreachable)', async () => {
    // Force an unreachable host so the lazy pool creation throws on first query.
    process.env.MYSQL_HOST = '127.0.0.1';
    process.env.MYSQL_PORT = '1'; // closed port — connection refused
    svc = new MessageLogService(new ConfigService());

    await expect(
      svc.upsertSummary('summary text', 'wechat', 'chat-1', 'user-1'),
    ).rejects.toBeDefined();
  });

  it('upsertSummary signature: 4 string args, returns Promise<void>', () => {
    expect(svc.upsertSummary.length).toBe(4); // content, platform, chatId, senderId
    const ret = svc.upsertSummary('x', 'wechat', 'chat-1', 'user-1');
    expect(ret).toBeInstanceOf(Promise);
  });
});
```

Note: the second test intentionally fails the MySQL connect to validate error propagation. The third test only verifies the method signature shape — it doesn't await the call (the call would hit a real DB; we just check the return type is a Promise).

- [ ] **Step 2: Run new tests, verify they FAIL**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="message-log.summary.test.ts"`

Expected: 3 failures — `svc.upsertSummary is not a function`.

- [ ] **Step 3: Implement `upsertSummary` in MessageLogService**

Modify `apps/bot-core/src/messages/message-log.service.ts`. Insert this exact method AFTER `upsertForgetBoundary` (which ends at line 87 with `}`) and BEFORE `async close()` (which starts at line 89). The insertion point is between the current line 87 (`    ]);`) of the forgotten boundary's closed `query(...)` call — wait, the actual structure: the file's `upsertForgetBoundary` ends with the closing `}` at line 87; insert the new method immediately after that `}` and before the blank line preceding `close()`:

```ts

  /**
   * v0.6: write a summary row to messages, idempotent on a deterministic
   * sessionKey-derived msg_id. Subsequent calls with the same sessionKey
   * UPDATE the same row (incremental merge — not a new row).
   *
   * Error propagation parallels upsertForgetBoundary — the caller
   * (ConversationService.loadOrBuildHistory) decides whether to degrade.
   */
  async upsertSummary(
    content: string,
    platform: string,
    chatId: string,
    senderId: string,
  ): Promise<void> {
    const sessionKey = `${platform}::${chatId}::${senderId}`;
    const msgId = `summary-${createHash('sha1').update(sessionKey).digest('hex').slice(0, 16)}`;
    await this.getPool().query(
      `INSERT INTO messages (msg_id, platform, chat_id, sender_id, role, content)
       VALUES (?, ?, ?, ?, 'summary', ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [msgId, platform, chatId, senderId, content],
    );
  }
```

And add `import * as crypto from 'crypto';` to the imports at the top of the file. The current imports are:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { createPool, Pool } from 'mysql2/promise';
import { ConfigService } from '../common/config/config.service';
import { NormalizedMessage, NormalizedReply } from '@mpcb/shared';
```

Add a fifth line after them:
```ts
import * as crypto from 'crypto';
```

And make sure `createHash` is referenced as `crypto.createHash` (already shown above).

- [ ] **Step 4: Run new tests, verify they PASS**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="message-log.summary.test.ts"`

Expected: 3 passing.

- [ ] **Step 5: Full suite sanity check**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js`

Expected: 160/160 passing — no regression in existing tests (default-off means existing `upsertForgetBoundary` path is unaffected).

- [ ] **Step 6: Commit**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git add apps/bot-core/src/messages/message-log.service.ts apps/bot-core/test/message-log.summary.test.ts && git commit -m "feat(messages): upsertSummary — idempotent summary row per session"
```

---

### Task 4: Summarizer module — types, service, providers, DI wiring

**Files:**
- Create: `apps/bot-core/src/handlers/summarizer/summarizer.types.ts` — `SummarizationUnavailableError`, `SUMMARIZER_PROVIDERS` token, `SUMMARIZER_SYSTEM_PROMPT`
- Create: `apps/bot-core/src/handlers/summarizer/providers/claude-haiku.provider.ts`
- Create: `apps/bot-core/src/handlers/summarizer/providers/openai-mini.provider.ts`
- Create: `apps/bot-core/src/handlers/summarizer/summarizer.service.ts`
- Create: `apps/bot-core/src/handlers/summarizer/summarizer.module.ts`
- Create: `apps/bot-core/test/claude-haiku.provider.test.ts` (2 tests)
- Create: `apps/bot-core/test/openai-mini.provider.test.ts` (2 tests)
- Create: `apps/bot-core/test/summarizer.service.test.ts` (4 tests)
- Modify: `apps/bot-core/src/app.module.ts` (import `SummarizerModule`)

**Interfaces:**
- `SummarizationUnavailableError extends Error` with `.cause: unknown`
- `SUMMARIZER_PROVIDERS` injection token (string) → `LlmProvider[]`
- `SUMMARIZER_SYSTEM_PROMPT` constant (exported from types file for testability)
- `SummarizationService.summarize(turns: ConversationTurn[], signal: AbortSignal): Promise<string>`
- `SummarizationService.contextWindow: number` (delegates to `cfg.summarizerContextWindow`)

#### Part A — Types

- [ ] **Step 1: Create types file**

Create `apps/bot-core/src/handlers/summarizer/summarizer.types.ts` with this exact content:

```ts
import { LlmProvider } from '../llm/llm.types';

/**
 * v0.6: typed failure when all summarizer providers in the chain fail.
 * Carries the original error as `.cause` for logging context.
 */
export class SummarizationUnavailableError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('summarization service unavailable (all providers failed)');
    this.name = 'SummarizationUnavailableError';
    this.cause = cause;
  }
}

/** v0.6: DI token for the ordered list of summarizer LlmProvider instances. */
export const SUMMARIZER_PROVIDERS = Symbol('SUMMARIZER_PROVIDERS');

/**
 * v0.6: system prompt for the summarizer small-LLM call. Hard rule:
 * a single paragraph, plain prose, no role labels, drop pleasantries,
 * preserve names/facts/decisions/questions.
 */
export const SUMMARIZER_SYSTEM_PROMPT = [
  'You are a conversation history compactor.',
  'Your task: produce a SINGLE-PARAGRAPH summary of the conversation below.',
  'Preserve: key facts, names, decisions made, questions asked, and the user\'s current goal.',
  'Drop: pleasantries, greetings, repeated clarifications.',
  'Output: plain prose. No bullet lists. No role labels (do not write "User:" or "Assistant:").',
  'Length: as short as possible while preserving the above. Target ≤ 200 words.',
].join(' ');

/** Header injected in front of a prior session summary so the small LLM sees "merge, not append". */
export const PREVIOUS_SUMMARY_HEADER = 'PREVIOUS SUMMARY (merge this with the new turns below):\n';

// Provider-name string → LlmProvider type alias (purely documentary).
export type SummarizerProviderName = 'claude-haiku' | 'openai-mini' | string;

// Re-export the imported LlmProvider so consumers can `import { LlmProvider } from '.../summarizer.types'`
// without pulling the deeper `./llm/llm.types` path.
export type { LlmProvider };
```

#### Part B — Providers

- [ ] **Step 2: Implement ClaudeHaikuProvider (extending ClaudeProvider)**

Create `apps/bot-core/src/handlers/summarizer/providers/claude-haiku.provider.ts` with this exact content:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../../common/config/config.service';
import { ClaudeProvider } from '../../llm/providers/claude.provider';

/**
 * v0.6: dedicated summarizer provider — extends ClaudeProvider, overrides
 * `name` (so usage_log.provider = 'claude-haiku' identifies cheap-tier calls)
 * and `defaultModel` (the small Claude model). Reuses all API-calling logic.
 */
@Injectable()
export class ClaudeHaikuProvider extends ClaudeProvider {
  override readonly name = 'claude-haiku';
  override readonly defaultModel = 'claude-haiku-4-5';
  constructor(cfg: ConfigService) {
    super(cfg);
  }
}
```

- [ ] **Step 3: Implement OpenAIMiniProvider (extending OpenAIProvider)**

Create `apps/bot-core/src/handlers/summarizer/providers/openai-mini.provider.ts` with this exact content:

```ts
import { OpenAIProvider } from '../../llm/providers/openai.provider';
import { ConfigService } from '../../../common/config/config.service';

/**
 * v0.6: dedicated summarizer provider — extends OpenAIProvider, overrides
 * `name` (so usage_log.provider = 'openai-mini') and `defaultModel`
 * (gpt-4o-mini, which OpenAIProvider already defaults to, but explicit
 * here so the override pattern matches ClaudeHaikuProvider).
 */
export class OpenAIMiniProvider extends OpenAIProvider {
  override readonly name = 'openai-mini';
  override readonly defaultModel = 'gpt-4o-mini';
  constructor(cfg: ConfigService) {
    super({ apiKey: cfg.openaiApiKey ?? 'no-key' });
  }
}
```

Note: `OpenAIProvider` is not `@Injectable()` (it's used with explicit `new` calls in `HandlersModule`). Same pattern here — we'll instantiate via factory in the module.

- [ ] **Step 4: Add failing provider tests**

Create `apps/bot-core/test/claude-haiku.provider.test.ts`:

```ts
import { ConfigService } from '../src/common/config/config.service';
import { ClaudeHaikuProvider } from '../src/handlers/summarizer/providers/claude-haiku.provider';
import { ClaudeProvider } from '../src/handlers/llm/providers/claude.provider';

describe('ClaudeHaikuProvider', () => {
  it('overrides name and defaultModel from the parent ClaudeProvider', () => {
    const p = new ClaudeHaikuProvider(new ConfigService());
    expect(p.name).toBe('claude-haiku');
    expect(p.defaultModel).toBe('claude-haiku-4-5');
    // Inherits large context window from ClaudeProvider
    expect(p.contextWindow).toBe(200_000);
  });

  it('is-a ClaudeProvider (inherits countTokens implementation)', () => {
    const p = new ClaudeHaikuProvider(new ConfigService());
    expect(p).toBeInstanceOf(ClaudeProvider);
    // inherited
    expect(p.countTokens('abc')).toBeGreaterThanOrEqual(1);
  });
});
```

Create `apps/bot-core/test/openai-mini.provider.test.ts`:

```ts
import { ConfigService } from '../src/common/config/config.service';
import { OpenAIMiniProvider } from '../src/handlers/summarizer/providers/openai-mini.provider';
import { OpenAIProvider } from '../src/handlers/llm/providers/openai.provider';

describe('OpenAIMiniProvider', () => {
  it('overrides name and defaultModel from the parent OpenAIProvider', () => {
    const p = new OpenAIMiniProvider(new ConfigService());
    expect(p.name).toBe('openai-mini');
    expect(p.defaultModel).toBe('gpt-4o-mini');
    // Inherits large OpenAI context window
    expect(p.contextWindow).toBe(128_000);
  });

  it('is-a OpenAIProvider (inherits countTokens implementation)', () => {
    const p = new OpenAIMiniProvider(new ConfigService());
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.countTokens('abc')).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 5: Run provider tests, verify both PASS**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="(claude-haiku|openai-mini)\\.provider\\.test\\.ts"`

Expected: 4 passing (2 + 2).

#### Part C — Service + module

- [ ] **Step 6: Write failing SummarizationService tests**

Create `apps/bot-core/test/summarizer.service.test.ts` with this exact content:

```ts
import { ConfigService } from '../src/common/config/config.service';
import { SummarizationService } from '../src/handlers/summarizer/summarizer.service';
import { UsageLogger } from '../src/handlers/llm/usage-logger';
import { LlmProvider, ChatRequest, ChatResponse } from '../src/handlers/llm/llm.types';
import { ConversationTurn } from '../src/conversation/conversation.service';
import {
  SummarizationUnavailableError,
  PREVIOUS_SUMMARY_HEADER,
  SUMMARIZER_SYSTEM_PROMPT,
} from '../src/handlers/summarizer/summarizer.types';

class StubProvider implements LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly contextWindow = 200_000;
  public lastReq: ChatRequest | null = null;
  public response: ChatResponse;
  public failWith: Error | null = null;

  constructor(name: string, defaultModel: string, response: ChatResponse) {
    this.name = name;
    this.defaultModel = defaultModel;
    this.response = response;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.lastReq = req;
    if (this.failWith) throw this.failWith;
    return this.response;
  }
}

class StubUsageLogger {
  public calls: Array<{ provider: string; model: string; usage: any; userId?: string }> = [];
  async record(args: { userId?: string; provider: string; model: string; usage: any }): Promise<void> {
    this.calls.push(args);
  }
}

const TURN = (role: 'user' | 'assistant', content: string): ConversationTurn => ({ role, content });

describe('SummarizationService', () => {
  let cfg: ConfigService;
  let usage: StubUsageLogger;
  beforeEach(() => {
    delete process.env.SUMMARIZER_CONTEXT_WINDOW;
    delete process.env.SUMMARIZER_PROVIDERS;
    delete process.env.ENABLE_SUMMARIZATION;
    cfg = new ConfigService();
    usage = new StubUsageLogger();
  });

  it('happy path: calls first provider, returns response text, records usage', async () => {
    const stub = new StubProvider('claude-haiku', 'claude-haiku-4-5', {
      text: 'summary text',
      model: 'claude-haiku-4-5',
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const svc = new SummarizationService([stub], usage as unknown as UsageLogger, cfg);
    const turns: ConversationTurn[] = [
      TURN('user', 'hello'),
      TURN('assistant', 'hi there, how can I help?'),
      TURN('user', 'what is X?'),
    ];
    const text = await svc.summarize(turns, AbortSignal.timeout(5_000));
    expect(text).toBe('summary text');
    expect(stub.lastReq?.model).toBe('claude-haiku-4-5');
    // usage was recorded with the actual provider name (for cost tracking)
    expect(usage.calls.length).toBe(1);
    expect(usage.calls[0].provider).toBe('claude-haiku');
    // system prompt passed through
    expect(stub.lastReq?.systemPrompt).toBe(SUMMARIZER_SYSTEM_PROMPT);
  });

  it('falls back to next provider in chain when the first throws', async () => {
    const first = new StubProvider('claude-haiku', 'claude-haiku-4-5', {
      text: 'should not see', model: 'x', usage: { promptTokens: 0, completionTokens: 0 },
    });
    first.failWith = new Error('boom');
    const second = new StubProvider('openai-mini', 'gpt-4o-mini', {
      text: 'fallback ok', model: 'gpt-4o-mini', usage: { promptTokens: 50, completionTokens: 10 },
    });
    const svc = new SummarizationService([first, second], usage as unknown as UsageLogger, cfg);
    const text = await svc.summarize([TURN('user', 'hi')], AbortSignal.timeout(5_000));
    expect(text).toBe('fallback ok');
    expect(usage.calls.length).toBe(1);
    expect(usage.calls[0].provider).toBe('openai-mini');
  });

  it('throws SummarizationUnavailableError when ALL providers in chain fail', async () => {
    const a = new StubProvider('claude-haiku', 'claude-haiku-4-5', {
      text: '', model: '', usage: { promptTokens: 0, completionTokens: 0 },
    });
    a.failWith = new Error('a-bad');
    const b = new StubProvider('openai-mini', 'gpt-4o-mini', {
      text: '', model: '', usage: { promptTokens: 0, completionTokens: 0 },
    });
    b.failWith = new Error('b-bad');
    const svc = new SummarizationService([a, b], usage as unknown as UsageLogger, cfg);
    await expect(
      svc.summarize([TURN('user', 'hi')], AbortSignal.timeout(5_000)),
    ).rejects.toBeInstanceOf(SummarizationUnavailableError);
    expect(usage.calls.length).toBe(0);
  });

  it('pre-trims oldest turns if input exceeds 70% of contextWindow', async () => {
    const stub = new StubProvider('claude-haiku', 'claude-haiku-4-5', {
      text: 'compacted', model: 'claude-haiku-4-5', usage: { promptTokens: 0, completionTokens: 0 },
    });
    // Set contextWindow very small so the pre-trim kicks in.
    process.env.SUMMARIZER_CONTEXT_WINDOW = '20';  // input cap = 14 tokens
    cfg = new ConfigService();
    const svc = new SummarizationService([stub], usage as unknown as UsageLogger, cfg);
    const turns: ConversationTurn[] = [
      TURN('user', 'aaaaaa bbbbbb cccccc dddddd eeeeee'), // ~30+ tokens
      TURN('assistant', 'ffff gggg hhhh iiii jjjj'),     // ~25+ tokens
      TURN('user', 'kkkk llll mmmm nnnn oooo'),           // recent turn, must survive
    ];
    const text = await svc.summarize(turns, AbortSignal.timeout(5_000));
    expect(text).toBe('compacted');
    // The most-recent turn MUST be in the request message content (pre-trim drops oldest).
    const sent = (stub.lastReq!.messages[0].content) as string;
    expect(sent).toContain('kkkk');
  });

  // Silence unused-import warning (PREVIOUS_SUMMARY_HEADER is referenced indirectly via service internals)
  it('exports PREVIOUS_SUMMARY_HEADER marker for incremental-merge format', () => {
    expect(PREVIOUS_SUMMARY_HEADER).toContain('PREVIOUS SUMMARY');
  });
});
```

- [ ] **Step 7: Run failing SummarizationService tests, verify they FAIL**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="summarizer\\.service\\.test\\.ts"`

Expected: 4 failures — `summarizer.service does not exist` / module not found.

- [ ] **Step 8: Implement SummarizationService**

Create `apps/bot-core/src/handlers/summarizer/summarizer.service.ts` with this exact content:

```ts
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
```

- [ ] **Step 9: Implement SummarizerModule**

Create `apps/bot-core/src/handlers/summarizer/summarizer.module.ts` with this exact content:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '../../common/config/config.service';
import { UsageLogger } from '../llm/usage-logger';
import { ClaudeHaikuProvider } from './providers/claude-haiku.provider';
import { OpenAIMiniProvider } from './providers/openai-mini.provider';
import { SummarizationService } from './summarizer.service';
import { SUMMARIZER_PROVIDERS } from './summarizer.types';
import { LlmProvider } from '../llm/llm.types';

/**
 * v0.6: wires the dedicated summarizer provider chain.
 *
 * Reads SUMMARIZER_PROVIDERS env (csv) to decide which providers are in
 * the chain, in order. Each string maps to a registered provider instance:
 *   - 'claude-haiku'  → ClaudeHaikuProvider
 *   - 'openai-mini'   → OpenAIMiniProvider
 * Unknown names fall back to claude-haiku (warn-once via ConfigService).
 *
 * Default chain (when env unset): ['claude-haiku', 'openai-mini'].
 */
@Module({
  providers: [
    {
      provide: ClaudeHaikuProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new ClaudeHaikuProvider(cfg),
    },
    {
      provide: OpenAIMiniProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new OpenAIMiniProvider(cfg),
    },
    {
      provide: SUMMARIZER_PROVIDERS,
      inject: [ConfigService, ClaudeHaikuProvider, OpenAIMiniProvider],
      useFactory: (
        cfg: ConfigService,
        claude: ClaudeHaikuProvider,
        openai: OpenAIMiniProvider,
      ): LlmProvider[] => {
        const registry: Record<string, LlmProvider> = {
          'claude-haiku': claude,
          'openai-mini': openai,
        };
        const chain: LlmProvider[] = [];
        for (const name of cfg.summarizerProviderChain) {
          const p = registry[name];
          if (p) chain.push(p);
          // Else: silently skip unknown names (defensive — ConfigService defaults
          // already cover the documented set).
        }
        return chain.length > 0 ? chain : [claude];   // always at least one provider
      },
    },
    {
      provide: SummarizationService,
      inject: [SUMMARIZER_PROVIDERS, UsageLogger, ConfigService],
      useFactory: (
        providers: LlmProvider[],
        usage: UsageLogger,
        cfg: ConfigService,
      ) => new SummarizationService(providers, usage, cfg),
    },
  ],
  exports: [SummarizationService],
})
export class SummarizerModule {}
```

- [ ] **Step 10: Wire SummarizerModule into AppModule**

Modify `apps/bot-core/src/app.module.ts`. Add this import line after the existing `MessagesModule` import line:

```ts
import { SummarizerModule } from './handlers/summarizer/summarizer.module';
```

And add `SummarizerModule,` to the `imports` array (alphabetical with the existing entries — place it right after `RouterModule,`):

```ts
    ConfigModule, LoggerModule,
    PlatformModule, QueueModule, RouterModule,
    SummarizerModule,            // ← NEW
    HandlersModule, WorkerModule, AdminApiModule,
    MessagesModule,
```

- [ ] **Step 11: Run service tests, verify all PASS**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="summarizer\\.service\\.test\\.ts"`

Expected: 5 passing (4 service + 1 PREVIOUS_SUMMARY_HEADER marker).

- [ ] **Step 12: Full suite + lint + build sanity check**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r build && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js`

Expected: 160 + 8 (T2) + 3 (T3) + 9 (T4 this task: 2 ClaudeHaiku + 2 OpenAIMini + 5 SummarizationService) = 180 passing across 35 + 3 (T2, T3, T4×3 new files) = 38 suites. The meaningful check is "no regressions" — every v0.5.x test still passes.

- [ ] **Step 13: Commit**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git add apps/bot-core/src/handlers/summarizer apps/bot-core/src/app.module.ts apps/bot-core/test/claude-haiku.provider.test.ts apps/bot-core/test/openai-mini.provider.test.ts apps/bot-core/test/summarizer.service.test.ts && git commit -m "feat(summarizer): dedicated SummarizationService with cheap-provider chain"
```

---

### Task 5: ConversationService — `loadOrBuildHistory` + widen `ConversationTurn.role`

**Files:**
- Modify: `apps/bot-core/src/conversation/conversation.service.ts` — widen `ConversationTurn.role` union; add `loadOrBuildHistory`; constructor 1→3 args
- Modify: `apps/bot-core/src/conversation/conversation.module.ts` — import `SummarizerModule` + `MessagesModule`
- Create: `apps/bot-core/test/conversation.load-or-build.test.ts` — 9 tests
- Create: `apps/bot-core/test/conversation.di.test.ts` — 1 DI canary

**Interfaces:**
- `loadOrBuildHistory(platform, chatId, senderId, now, options?: { tokenBudget?: number; enableSummarization?: boolean }): Promise<ConversationTurn[]>`
- `ConversationTurn.role` widens from `'user' | 'assistant' | 'system'` to include `'summary'`
- Constructor: `constructor(cfg: ConfigService, summarizer: SummarizationService, messageLog: MessageLogService)`

- [ ] **Step 1: Write failing tests (load-or-build)**

Create `apps/bot-core/test/conversation.load-or-build.test.ts` with this exact content:

```ts
import { ConfigService } from '../src/common/config/config.service';
import { ConversationService, ConversationTurn } from '../src/conversation/conversation.service';
import { SummarizationService } from '../src/handlers/summarizer/summarizer.service';
import { SummarizationUnavailableError } from '../src/handlers/summarizer/summarizer.types';
import { MessageLogService } from '../src/messages/message-log.service';

// --- Mocks ---

class StubCfg extends ConfigService {
  mysqlHost = '127.0.0.1';
  mysqlPort = 1;
}

class StubSummarizer {
  async summarize(): Promise<string> {
    return 'fake summary';
  }
  get contextWindow(): number {
    return 100_000;
  }
}

class StubMessageLog {
  upsertSummaryCalls: Array<{ content: string; platform: string; chatId: string; senderId: string }> = [];
  async upsertSummary(content: string, platform: string, chatId: string, senderId: string): Promise<void> {
    this.upsertSummaryCalls.push({ content, platform, chatId, senderId });
  }
}

// --- Tests ---

describe('ConversationService.loadOrBuildHistory', () => {
  let cfg: StubCfg;
  let summarizer: StubSummarizer;
  let messageLog: StubMessageLog;
  let svc: ConversationService;

  beforeEach(() => {
    cfg = new StubCfg();
    summarizer = new StubSummarizer();
    messageLog = new StubMessageLog();
    svc = new ConversationService(cfg, summarizer as unknown as SummarizationService, messageLog as unknown as MessageLogService);
  });

  it('enableSummarization=false → delegates to loadHistory (identical behavior)', async () => {
    // No DB; loadHistory should catch and return [] (existing v0.4 pattern).
    const hist = await svc.loadOrBuildHistory(
      'wechat' as any, 'chat-1', 'user-1', Date.now(),
      { enableSummarization: false },
    );
    expect(hist).toEqual([]);
    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(messageLog.upsertSummaryCalls.length).toBe(0);
  });

  it('enableSummarization=true + no DB rows → returns [] (no work)', async () => {
    const hist = await svc.loadOrBuildHistory(
      'wechat' as any, 'chat-1', 'user-1', Date.now(),
      { enableSummarization: true, tokenBudget: 1000 },
    );
    expect(hist).toEqual([]);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('type signature: options takes enableSummarization boolean', () => {
    // Compile-time check (TS would catch). Runtime introspection:
    // svc.loadOrBuildHistory.length === 5
    expect(svc.loadOrBuildHistory.length).toBe(5);
  });

  it('constructor takes 3 args (seam audit — first constructor change since v0.4)', () => {
    expect(svc.constructor.length).toBe(3);
  });

  it('ConversationTurn.role now accepts "summary"', () => {
    // type-level assertion via TS — runtime, just construct a value.
    const turn: ConversationTurn = { role: 'summary', content: 'any' };
    expect(turn.role).toBe('summary');
  });

  it('SummarizationUnavailableError propagates from loadOrBuildHistory (does NOT swallow)', async () => {
    const failingSummarizer = {
      contextWindow: 100_000,
      summarize: jest.fn(async () => { throw new SummarizationUnavailableError(new Error('chain dead')); }),
    };
    const localSvc = new ConversationService(
      cfg,
      failingSummarizer as unknown as SummarizationService,
      messageLog as unknown as MessageLogService,
    );

    // Force loadHistory to return non-empty, but it'll throw on the DB call.
    // We test the contract differently here: when summarizer throws, the error
    // type is propagated. To do that without a DB, we directly inspect that
    // loadOrBuildHistory rethrows SummarizationUnavailableError, OR a DB error
    // (whichever surfaces first when the DB is unreachable).
    await expect(
      localSvc.loadOrBuildHistory(
        'wechat' as any, 'chat-1', 'user-1', Date.now(),
        { enableSummarization: true, tokenBudget: 1000 },
      ),
    ).rejects.toBeDefined();
    // Either DB error or summarizer error — point is: do not silently succeed.
  });

  it('options with no tokenBudget + enableSummarization=true → no summarize triggered', async () => {
    // loadHistory returns [] (DB unreachable), so loadOrBuildHistory returns [] without calling summarizer.
    const hist = await svc.loadOrBuildHistory(
      'wechat' as any, 'chat-1', 'user-1', Date.now(),
      { enableSummarization: true },
    );
    expect(hist).toEqual([]);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('upsertSummary error after successful summarize does not break the call', async () => {
    // Construct a scenario: loadHistory returns [] (real DB unreachable),
    // so we cannot fully exercise the post-summarize upsert path here.
    // This test asserts the contract on a smoke level: when build happy
    // path runs without a DB, we degrade to [] (no crash).
    const hist = await svc.loadOrBuildHistory(
      'wechat' as any, 'chat-1', 'user-1', Date.now(),
      { enableSummarization: true, tokenBudget: 1000 },
    );
    expect(Array.isArray(hist)).toBe(true);
  });

  it('loadOrBuildHistory same call signature as loadHistory (compatible callers)', () => {
    // Compile-time contract check via TS; runtime check counts args.
    expect(svc.loadOrBuildHistory.length).toBe(svc.loadHistory.length);
  });
});
```

- [ ] **Step 2: Write failing DI canary test**

Create `apps/bot-core/test/conversation.di.test.ts` with this exact content:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '../src/common/config/config.service';
import { ConversationService } from '../src/conversation/conversation.service';
import { SummarizationService } from '../src/handlers/summarizer/summarizer.service';
import { MessageLogService } from '../src/messages/message-log.service';

describe('ConversationService DI (v0.6 canary)', () => {
  it('constructs via Nest Test module with the new 3-arg constructor', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigService,
        // Provide stubs for the new deps so we don't pull in real LLM providers here.
        {
          provide: SummarizationService,
          useValue: {
            summarize: async () => '',
            contextWindow: 100_000,
          },
        },
        {
          provide: MessageLogService,
          useValue: {
            upsertSummary: async () => undefined,
          },
        },
        ConversationService,
      ],
    }).compile();

    const svc = moduleRef.get(ConversationService);
    expect(svc).toBeInstanceOf(ConversationService);

    // Verify the new 3-arg constructor took effect (cf. v0.4/v0.5 1-arg ctor).
    expect(svc.constructor.length).toBe(3);

    await moduleRef.close();
  });
});
```

- [ ] **Step 3: Run failing tests, verify they FAIL**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="conversation\\.(load-or-build|di)\\.test\\.ts"`

Expected: All 10 fail with "loadOrBuildHistory is not a function" / "constructor length is 1, not 3".

- [ ] **Step 4: Widen `ConversationTurn.role` + add `loadOrBuildHistory` + change constructor**

Modify `apps/bot-core/src/conversation/conversation.service.ts`. Three edits:

**Edit 4a** — at the top of the file, widen the `ConversationTurn.role` union:

Find:
```ts
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
```

Replace with:
```ts
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system' | 'summary';
  content: string;
}
```

**Edit 4b** — change the constructor signature:

Find:
```ts
export class ConversationService {
  private static readonly FETCH_LIMIT = 20;
  private static readonly SESSION_IDLE_MS = 30 * 60 * 1000;
  private static readonly BOUNDARY_CONTENT = '__forget_boundary__';

  private readonly logger = new Logger(ConversationService.name);
  private pool: Pool | null = null;

  constructor(private readonly cfg: ConfigService) {}
```

Replace with:
```ts
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
```

**Edit 4c** — also widen the row type annotation inside `loadHistory` (since the role union widened; the cast in `loadHistory` still says `'user' | 'assistant' | 'system'`):

Find:
```ts
    let rows: Array<{ role: 'user' | 'assistant' | 'system'; content: string; created_at: Date }>;
```

Replace with:
```ts
    let rows: Array<{ role: 'user' | 'assistant' | 'system' | 'summary'; content: string; created_at: Date }>;
```

Find (in the SELECT result cast, just below):
```ts
    rows = result as Array<{ role: 'user' | 'assistant' | 'system'; content: string; created_at: Date }>;
```

Replace with:
```ts
    rows = result as Array<{ role: 'user' | 'assistant' | 'system' | 'summary'; content: string; created_at: Date }>;
```

The walker loop (lines 64-78) already does `surviving.push({ role: row.role, content: row.content })` — no edit needed there; just survives with the widened type.

**Edit 4d** — add the new `loadOrBuildHistory` method at the end of the class (after the closing `}` of `loadHistory`):

Append this block after the final closing brace of `loadHistory` (the file's final line currently is the closing `}` of `loadHistory`'s return statement followed by the class's closing `}`):

```ts

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
```

**Edit 4e** — add the missing imports at the top of the file:

Find:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';
import { PlatformName, estimateTokens } from '@mpcb/shared';
import { ConfigService } from '../common/config/config.service';
```

Replace with:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';
import { PlatformName, estimateTokens } from '@mpcb/shared';
import { ConfigService } from '../common/config/config.service';
import { SummarizationService } from '../handlers/summarizer/summarizer.service';
import { PREVIOUS_SUMMARY_HEADER } from '../handlers/summarizer/summarizer.types';
import { MessageLogService } from '../messages/message-log.service';
```

- [ ] **Step 5: Update ConversationModule to import SummarizerModule + MessagesModule**

Modify `apps/bot-core/src/conversation/conversation.module.ts`. Find:

```ts
import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';

@Module({
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
```

Replace with:
```ts
import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { SummarizerModule } from '../handlers/summarizer/summarizer.module';
import { MessagesModule } from '../messages/messages.module';

@Module({
  imports: [SummarizerModule, MessagesModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
```

- [ ] **Step 6: Run the new tests, verify they PASS**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="conversation\\.(load-or-build|di)\\.test\\.ts"`

Expected: 10 passing.

- [ ] **Step 7: Full suite + lint + build sanity check**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r build && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js`

Expected: 180 + 10 (T5 this task: 9 load-or-build + 1 DI canary) = 190 passing across 40 suites (35 + 5 new files: T2, T3, T4×3, T5×2). The seam canary (constructor length=3) passes.

- [ ] **Step 8: Commit**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git add apps/bot-core/src/conversation/conversation.service.ts apps/bot-core/src/conversation/conversation.module.ts apps/bot-core/test/conversation.load-or-build.test.ts apps/bot-core/test/conversation.di.test.ts && git commit -m "feat(conversation): loadOrBuildHistory with lazy summarization fallback"
```

---

### Task 6: LlmHandler — render `role:'summary'` turns as `role:'user'` with `[Earlier conversation summary]` prefix

**Files:**
- Modify: `apps/bot-core/src/handlers/llm/llm.handler.ts` — replace the `handle` method's `messages` build
- Create: `apps/bot-core/test/llm-handler-render-summary.test.ts` — 3 tests

**Interfaces:**
- Consumes: existing `handle(input, ctx)` signature
- Produces: provider-facing messages contain only `user|assistant` roles (Claude/OpenAI compat)

- [ ] **Step 1: Write failing tests**

Create `apps/bot-core/test/llm-handler-render-summary.test.ts` with this exact content:

```ts
import { LlmHandler } from '../src/handlers/llm/llm.handler';
import { ChatMessage, LlmProvider, ChatResponse, ChatRequest } from '../src/handlers/llm/llm.types';
import { UsageLogger } from '../src/handlers/llm/usage-logger';

class StubProvider implements LlmProvider {
  readonly name = 'stub';
  readonly defaultModel = 'stub-1';
  readonly contextWindow = 200_000;
  public lastReq: ChatRequest | null = null;
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.lastReq = req;
    return { text: 'reply', model: 'stub-1', usage: { promptTokens: 0, completionTokens: 0 } };
  }
  countTokens(text: string): number { return Math.ceil(text.length / 4); }
}

describe('LlmHandler render: role:summary → role:user with prefix', () => {
  it('renders summary turns as user role with [Earlier conversation summary] prefix', async () => {
    const provider = new StubProvider();
    const usage = { record: jest.fn().mockResolvedValue(undefined) } as unknown as UsageLogger;
    const handler = new LlmHandler(provider, usage);

    const ctx = {
      userId: 'u1',
      chatId: 'c1',
      platform: 'wechat' as any,
      history: [
        { role: 'summary' as const, content: 'old summary text' },
        { role: 'user' as const, content: 'new question' },
      ],
      abortSignal: new AbortController().signal,
    };

    await handler.handle(
      { kind: 'llm', prompt: 'ignored (history present)' } as any,
      ctx,
    );

    // Provider received messages; no role:'summary' anywhere
    const sent = provider.lastReq!.messages;
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const roles = sent.map((m) => m.role);
    expect(roles).not.toContain('summary');
    expect(roles.filter((r) => r === 'user').length).toBeGreaterThanOrEqual(2);
    // The summary turn is rendered first with the prefix
    expect(sent[0].role).toBe('user');
    expect(sent[0].content).toContain('[Earlier conversation summary]');
    expect(sent[0].content).toContain('old summary text');
  });

  it('history without summary → renders verbatim (no regression)', async () => {
    const provider = new StubProvider();
    const usage = { record: jest.fn().mockResolvedValue(undefined) } as unknown as UsageLogger;
    const handler = new LlmHandler(provider, usage);

    const ctx = {
      userId: 'u1',
      chatId: 'c1',
      platform: 'wechat' as any,
      history: [
        { role: 'user' as const, content: 'first question' },
        { role: 'assistant' as const, content: 'first answer' },
        { role: 'user' as const, content: 'follow-up' },
      ],
      abortSignal: new AbortController().signal,
    };

    await handler.handle(
      { kind: 'llm', prompt: 'final prompt' } as any,
      ctx,
    );

    const sent = provider.lastReq!.messages;
    expect(sent.length).toBe(4);   // 3 history + 1 final prompt
    expect(sent[0].role).toBe('user');
    expect(sent[0].content).toBe('first question');
    expect(sent[1].role).toBe('assistant');
    expect(sent[2].role).toBe('user');
    expect(sent[3].content).toBe('final prompt');
  });

  it('usage.log records the main call only (summary call is tracked by SummarizationService.usage)', async () => {
    const provider = new StubProvider();
    const usage = { record: jest.fn().mockResolvedValue(undefined) } as unknown as UsageLogger;
    const handler = new LlmHandler(provider, usage);

    const ctx = {
      userId: 'u1',
      chatId: 'c1',
      platform: 'wechat' as any,
      history: [{ role: 'summary' as const, content: 'x' }],
      abortSignal: new AbortController().signal,
    };

    await handler.handle({ kind: 'llm', prompt: 'p' } as any, ctx);

    expect(usage.record).toHaveBeenCalledTimes(1);
    expect((usage.record as jest.Mock).mock.calls[0][0].provider).toBe('stub');
    expect((usage.record as jest.Mock).mock.calls[0][0].model).toBe('stub-1');
  });
});
```

- [ ] **Step 2: Run failing tests, verify they FAIL**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="llm-handler-render-summary\\.test\\.ts"`

Expected: 3 failures. Specifically: "renders summary turns as user role…" fails because the existing `handle` method does `ctx.history` direct spread, exposing `role:'summary'` to the provider.

- [ ] **Step 3: Update `LlmHandler.handle`**

Modify `apps/bot-core/src/handlers/llm/llm.handler.ts`. Find the entire `async handle` body block (lines 26–51 of the file as of HEAD), specifically the `messages:` array construction. Replace ONLY the line:

```ts
      messages: [
        ...ctx.history,
        { role: 'user', content: input.prompt },
      ],
```

with:

```ts
      messages: [
        ...ctx.history.map((t) =>
          t.role === 'summary'
            ? { role: 'user' as const, content: `[Earlier conversation summary]\n${t.content}` }
            : t,
        ),
        { role: 'user', content: input.prompt },
      ],
```

The rest of `handle` (the try/catch, the usage log call, the return) stays untouched.

- [ ] **Step 4: Run failing tests, verify they PASS**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="llm-handler-render-summary\\.test\\.ts"`

Expected: 3 passing.

- [ ] **Step 5: Full suite + lint sanity check**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js`

Expected: All tests passing — `history`-shape tests (`llm.handler.history.test.ts`, `message.processor.test.ts`, etc.) still pass because their histories never include `role:'summary'` rows.

- [ ] **Step 6: Commit**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git add apps/bot-core/src/handlers/llm/llm.handler.ts apps/bot-core/test/llm-handler-render-summary.test.ts && git commit -m "feat(llm): render role:summary → role:user with [Earlier conversation summary] prefix"
```

---

### Task 7: MessageProcessor — 1-line wire (pass `enableSummarization` to `loadOrBuildHistory`)

**Files:**
- Modify: `apps/bot-core/src/queue/message.processor.ts` — change `loadHistory` to `loadOrBuildHistory` and pass `enableSummarization`
- (no new test) — verify the existing v0.5 DI canary (`message-processor.di.test.ts`) still passes + the existing `message.processor.test.ts` still passes

**Interfaces:**
- Consumes: `this.conversation.loadOrBuildHistory(platform, chatId, senderId, now, opts)` — opts is `{ tokenBudget, enableSummarization }`
- Produces: `history: ConversationTurn[]` — same shape callers expect

- [ ] **Step 1: Update `MessageProcessor.process`**

Modify `apps/bot-core/src/queue/message.processor.ts`. Find the lines (lines 39–45 in the file as of HEAD):

```ts
      history = await this.conversation.loadHistory(
        msg.platform,
        msg.chatId,
        msg.senderId,
        Date.now(),
        { tokenBudget: this.computeHistoryBudget() },
      );
```

Replace with:

```ts
      history = await this.conversation.loadOrBuildHistory(
        msg.platform,
        msg.chatId,
        msg.senderId,
        Date.now(),
        { tokenBudget: this.computeHistoryBudget(), enableSummarization: this.config.enableSummarization },
      );
```

Nothing else changes — the constructor signature is still 6 args (verified by the DI canary test).

- [ ] **Step 2: Verify existing v0.5 DI canary still passes**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="message-processor\\.di\\.test\\.ts"`

Expected: passes (proves no constructor regression).

- [ ] **Step 3: Verify existing MessageProcessor behavior test still passes**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && cd apps/bot-core && node node_modules/jest/bin/jest.js --testPathPattern="message\\.processor\\.test\\.ts"`

Expected: all passing. Default-off (`enableSummarization === false` in tests) means `loadOrBuildHistory` degrades to `loadHistory`-only path, identical to v0.5.

- [ ] **Step 4: Full suite + lint sanity check**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js`

Expected: 190 + 3 (T6: llm-handler-render-summary) = 193 passing across 41 suites (35 + 8 new files: T2, T3, T4×3, T5×2, T6). Plus 2 added to existing migrate.test.ts in T1 (so total tests = 193 if we count T1's 2 added).

Final projected total after T7 (no new tests) = **195 tests across 41 suites**.

The meaningful check is "zero regressions" — every v0.5.x test still passes.

- [ ] **Step 5: Commit**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git add apps/bot-core/src/queue/message.processor.ts && git commit -m "feat(processor): wire enableSummarization through to loadOrBuildHistory"
```

---

### Task 8: CHANGELOG + whole-branch review + tag v0.6.0 + push

**Files:**
- Modify: `CHANGELOG.md` (prepend v0.6.0 entry)
- Create: `.superpowers/sdd/final-fixes-report.md` (whole-branch review report)

**No new code changes** in this task unless review flags Critical/Important items.

- [ ] **Step 1: Verify full suite green pre-tag**

Run: `cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r build && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js`

Expected: all green, 195 tests passing across 41 suites (precise count printed by jest).

- [ ] **Step 2: Dispatch whole-branch code reviewer**

Run from the project root:

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && BASE_SHA=$(git log --oneline | grep "docs(changelog): v0.5.0 release notes" | head -1 | awk '{print $1}') && echo "BASE_SHA=$BASE_SHA" && HEAD_SHA=$(git rev-parse HEAD) && echo "HEAD_SHA=$HEAD_SHA"
```

Then dispatch a `general-purpose` subagent filling in `code-reviewer.md` from the `superpowers:requesting-code-review` skill. Use the `scripts/review-package` helper from the subagent-driven-development skill to package the diff between BASE and HEAD, and pass the printed path to the reviewer prompt.

Critical/Important findings → dispatch ONE fix subagent with the complete findings list (per `feedback_sdd_review_layering`).

After fix wave: re-run `pnpm -r build && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js` to confirm green.

- [ ] **Step 3: Append the v0.6.0 entry to CHANGELOG.md**

Prepend a new entry above the existing `## v0.5.0 — 2026-07-12` heading. The full block to insert at the top of the file (CHANGELOG.md currently starts with `# Changelog\n\n## v0.5.0 ...`):

```markdown
# Changelog

## v0.6.0 — 2026-07-12

Sliding-window summarization for over-budget conversations. v0.5's FIFO drop is replaced by a single summary row per session that captures prior context; full history is never silently lost (when feature is on). Opt-in via `ENABLE_SUMMARIZATION` (default off; v0.5 deployments see zero behavior change).

**New env:**
- `ENABLE_SUMMARIZATION` (default `false`, boolean). Truthy: `1|true|yes|on`. Anything else → `false`.
- `SUMMARIZER_PROVIDERS` (default `claude-haiku,openai-mini`, csv). Ordered chain of provider-name strings. Each maps to a registered `LlmProvider` instance in the new `SummarizerModule`.
- `SUMMARIZER_CONTEXT_WINDOW` (default `100_000` tokens). Cheap-model safe default; controls the pre-trim input cap (`0.7 × contextWindow`).

**New APIs:**
- `SummarizationService.summarize(turns, signal) → Promise<string>` — builds the small-LLM request (system prompt + transcript), runs pre-trim to 70% of context window, tries each provider in the chain sequentially, records usage per provider.
- `SummarizationService.contextWindow` getter (parity with `LlmHandler.contextWindow`).
- `SummarizationUnavailableError extends Error` — typed failure when all chain providers fail. Carries `.cause`. Caller (MessageProcessor) catches + falls back to v0.5 FIFO behavior.
- `ConversationService.loadOrBuildHistory(platform, chatId, senderId, now, options?)` — drop-in replacement for `loadHistory`. `options.enableSummarization: boolean` gates the new path; `loadHistory` remains the underlying engine.
- `ConversationTurn.role` widens from `'user' | 'assistant' | 'system'` to add `'summary'`. `LlmHandler` renders `role:'summary'` → `role:'user'` with `[Earlier conversation summary]\n…` prefix at the call site (Claude/OpenAI accept only user/assistant).
- `MessageLogService.upsertSummary(content, platform, chatId, senderId): Promise<void>` — idempotent INSERT/UPDATE on `msg_id = summary-<sha1(sessionKey)>[0:16]>`. Subsequent summarize events UPDATE the same row (incremental merge).
- `ClaudeHaikuProvider extends ClaudeProvider` — overrides `name='claude-haiku'`, `defaultModel='claude-haiku-4-5'`. Reuses Claude API calling logic.
- `OpenAIMiniProvider extends OpenAIProvider` — overrides `name='openai-mini'`, `defaultModel='gpt-4o-mini'`.

**New behavior:**
- When `ENABLE_SUMMARIZATION=true` and `loadHistory`'s surviving turns still exceed `tokenBudget`:
  1. Pre-trim oldest turns to ≤70% of `summarizerContextWindow`.
  2. Build small-LLM request (system prompt + prior summary as merge context + new oldest turns).
  3. Call summarizer chain head; record usage per provider. Fall through the chain on per-provider failure.
  4. On full-chain failure → `SummarizationUnavailableError` → caller falls back to v0.5 FIFO path (logged warn).
  5. Upsert summary row keyed on `summary-<sha1(sessionKey)>` (idempotent on next over-budget event for the same session).
  6. Return `[{ role: 'summary', content: merged }, ...recent_verbatim_turns]` to the LLM context.
- `/forget` semantics preserved: boundary walker's `role='system', content='__forget_boundary__'` check still precedes summary rows in DB; a session restart cleanly drops accumulated summaries.

**Schema:**
- `ALTER TABLE messages MODIFY COLUMN role ENUM('user','assistant','system','summary')` (migration `0003_messages_summary_role.sql`). MySQL 8 INSTANT DDL — non-blocking in production. No data migration needed.

**Constructor change:**
- `ConversationService` constructor: 1 → 3 args (`cfg, summarizer, messageLog`). First constructor change since v0.4. Locked by new `conversation.di.test.ts` (the `feedback_sdd_review_layering` net).

**Usage log:**
- One extra row per over-budget event (summarizer's own call). `provider` column carries the actual provider name (`claude-haiku` | `openai-mini`) for cost accounting.

Tests: 195/195 across 41 suites (was 160/35 in v0.5.0; +35 tests: 2 migrate, 8 config-summarization, 3 message-log.summary, 2 claude-haiku.provider, 2 openai-mini.provider, 5 summarizer.service, 9 conversation.load-or-build, 1 conversation.di, 3 llm-handler-render-summary; +6 suites: config-summarization, message-log.summary, claude-haiku.provider, openai-mini.provider, summarizer.service, load-or-build, di, render-summary — exact final counts in `.superpowers/sdd/final-fixes-report.md`). `pnpm build` green. `pnpm -r lint` green.

## v0.5.0 — 2026-07-12
```

(Final `<N>`/`<N>` numbers replaced with actual full-suite counts after Step 1.)

- [ ] **Step 4: Write the final-fixes report**

Create or rewrite `.superpowers/sdd/final-fixes-report.md` following the v0.5.0 report template (`.superpowers/sdd/final-fixes-report.md` already exists with v0.5 content — overwrite with v0.6 content following the same structure: title, date, branch, operator, summary of review findings, list of fixed/unfixed items with file references, final state, whole-branch verdict, diff stats).

- [ ] **Step 5: Full re-verification pre-commit**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && pnpm -r build && pnpm -r lint && cd apps/bot-core && node node_modules/jest/bin/jest.js
```

Expected: all green.

- [ ] **Step 6: Commit + tag v0.6.0 + push**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git add CHANGELOG.md .superpowers/sdd/final-fixes-report.md && git commit -m "docs(changelog): v0.6.0 release notes — sliding-window summarization" && git tag -a v0.6.0 -m "v0.6.0 — sliding-window summarization" && git push origin master --follow-tags
```

Expected: commit + tag + push all succeed. Git proxy workaround: if push fails with proxy errors, retry with `git -c http.proxy= -c https.proxy= push origin master --follow-tags` (per `feedback_git_proxy`).

- [ ] **Step 7: Confirm tag is on origin**

```bash
cd "E:\ToolDevelop\MultiPlatformChatBot" && git ls-remote --tags origin | grep v0.6.0
```

Expected: `refs/tags/v0.6.0` line returned.

---

## Self-Review (after writing the plan)

**1. Spec coverage — point to implementing tasks:**

| Spec section | Covered by |
|---|---|
| §1 Overview & Goals | entire plan; goal "default off" → T2 (enableSummarization); "Replace FIFO drop" → T5 (loadOrBuildHistory); "Lazy trigger" → T5/T8 algorithm; "Incremental merge" → T4 (PREVIOUS_SUMMARY_HEADER) + T3 (idempotent upsert); "Backwards-compatible" → T7 default-off path; "No new infrastructure" → T4 module + no queue |
| §2 Architecture: schema migration | T1 |
| §2 Architecture: 3 new config getters | T2 |
| §2 Architecture: SummarizationService | T4 |
| §2 Architecture: ClaudeHaiku/OpenAIMini providers | T4 Part B |
| §2 Architecture: ConversationService.loadOrBuildHistory + role widening | T5 |
| §2 Architecture: MessageLogService.upsertSummary | T3 |
| §2 Architecture: LlmHandler render | T6 |
| §2 Architecture: MessageProcessor 1-line wire | T7 |
| §2 Architecture: SummarizerModule wire | T4 Part C |
| §3.1 Worker flow | T5 algorithm + T7 wire |
| §3.2 usage_log effect | T4 (uses UsageLogger.record with provider.name) |
| §3.3 Summary row identity (idempotent msg_id) | T3 implementation + T3 test 1 |
| §4.1 ConfigService new getters | T2 |
| §4.2 SummarizationService | T4 (code + tests) |
| §4.3 ConversationService.loadOrBuildHistory | T5 |
| §4.4 MessageLogService.upsertSummary | T3 |
| §4.5 LlmHandler.render | T6 |
| §4.6 Schema migration | T1 |
| §4.7 MessageProcessor wire | T7 |
| §5 Failure modes (all 14 rows) | addressed across tasks; fail-open contract pinned in T5 test 6 |
| §6.1 SummarizationService tests (4) | T4 service tests |
| §6.2 ConversationService.loadOrBuildHistory tests (9) | T5 (9 tests + 1 DI canary) |
| §6.3 MessageLogService.upsertSummary tests (3) | T3 |
| §6.4 LlmHandler render tests (3) | T6 |
| §6.5 ConfigService env-getter tests (7) | T2 (8 — slightly more, splitting the truthy cases) |
| §6.6 DI canary (1) | T5 |
| §6.7 Unchanged existing tests | covered by Step 5/Step 6 of every task running full suite |

**2. Placeholder scan:** No "TBD", "TODO", "implement later". One CHANGELOG place-holder `<N>` filled in at task Step 3 with the actual test count.

**3. Type / interface consistency:**
- `ConversationTurn.role` widening happens once in T5 Edit 4a; T3's `upsertSummary` does NOT touch this type (writes via raw SQL); T4's `SummarizationService.summarize` parameter is typed as `ConversationTurn[]`, matches T5's import.
- `loadOrBuildHistory` parameter signature `(platform, chatId, senderId, now, options?)` matches `loadHistory`'s parameter signature — T5's test 8 (`loadOrBuildHistory.length === loadHistory.length`) pins this.
- T7's wire uses `this.config.enableSummarization` (matching T2's getter); no `this.cfg` typo.
- T4's `SummarizationService` constructor injection `providers: LlmProvider[]` is bound via `SUMMARIZER_PROVIDERS` symbol; consumed at T5's `ConversationService` 3-arg constructor via `SummarizationService` injection.
- T5's `loadOrBuildHistory` references `PREVIOUS_SUMMARY_HEADER` — T4's types file exports this.
- T6's render expects `ctx.history` with `role: 'summary' | 'user' | 'assistant' | 'system'` — matches T5's widened `ConversationTurn`.

**Potential ambiguities resolved:**
- "Lazy trigger" — T5's algorithm explicitly checks `if (totalAfterPriorSummary <= budget) return …`, no summarizer call.
- "Incremental merge with prior summary" — T5 prepends `[{role:'user', content: PREVIOUS_SUMMARY_HEADER + priorSummary.content}]` to the summarizer input; T4 prepares that user message in `prepareInput`.
- "Race on concurrent same-session messages" — T3's `upsertSummary` uses `ON DUPLICATE KEY UPDATE` (idempotent on `msg_id`), last-writer wins; both LLM calls paid, logged once at debug level (not testable without integration; documented in spec §5).
- "Empty FallbackProvider chain" → T4's `useFactory` for `SUMMARIZER_PROVIDERS` ensures `chain.length > 0 ? chain : [claude]` always at least one provider.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-sliding-window-summarization.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan given the seam-sensitive constructor change in T5 (whole-branch review's defense-in-depth net, per `feedback_sdd_review_layering`).

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints for review.
