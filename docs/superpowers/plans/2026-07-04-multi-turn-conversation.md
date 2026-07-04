# Multi-Turn Conversation Context (v0.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LLM handler see prior conversation turns within a 30-minute session window, sourced from the existing `messages` MySQL table.

**Architecture:** New `ConversationService` reads `(platform, chat_id, sender_id)` rows from `messages` ordered by `created_at` desc, applies a 30-minute sliding window filter, returns the last 10 turns in ascending order. `MessageProcessor` calls it before dispatch and populates `ctx.history`. `LlmHandler` already consumes `ctx.history` (no code change there) — only its test coverage is added.

**Tech Stack:** NestJS module, mysql2/promise (existing pool in `WorkerModule`), TypeScript strict mode.

## Global Constraints

These apply to every task. They are NOT repeated per task.

- **NO DOCKER for verification.** Validate via `pnpm build`, `pnpm -r test`, `pnpm -r lint`. Do not run `docker compose`, `docker`, anything hitting live MySQL/Redis/Qdrant.
- **Test style:** mock-based unit tests with `jest`. No Testcontainers, no live DB.
- **TypeScript strict mode** — no `any` in production code, no `@ts-ignore`, no `// eslint-disable` introduced by these tasks.
- **Conventional commits** — every commit uses `feat:` / `fix:` / `test:` / `docs:` prefix.
- **Files end with a single trailing newline** (POSIX).
- **Existing infrastructure to reuse:**
  - `messages` MySQL table (schema in `apps/bot-core/migrations/0001_init.sql:25-37`) — already populated by `MessageLogService` (v0.1.1 fix #3).
  - `HandlerContext.history: Array<{role, content}>` and `RouteContext.history: Array<{role, content}>` — already declared in `apps/bot-core/src/handlers/handler.interface.ts:8` and `apps/bot-core/src/router/router.types.ts:7`. LlmHandler already uses `ctx.history.slice(-5)` at `apps/bot-core/src/handlers/llm/llm.handler.ts:22`.
  - `MessageProcessor` is constructed manually in `WorkerModule.onModuleInit()` (`apps/bot-core/src/queue/worker.module.ts:40-45`), passing the existing pool.
- **Out of scope:** token-budget truncation, summarization, RAG over history, `/forget`, KB query expansion using history, conversation retention cleanup job — all explicitly v0.3+ per the design spec.
- **NO new top-level dependencies.** Use `mysql2/promise` already in the project.
- **Branch:** `master`. Repo `https://github.com/fogyisland/chatbot`.

---

## File Structure Map

| File | Status | Responsibility |
|---|---|---|
| `apps/bot-core/src/conversation/conversation.service.ts` | CREATE | `ConversationService.loadHistory(platform, chatId, senderId, now)` |
| `apps/bot-core/src/conversation/conversation.module.ts` | CREATE | Nest module that provides `ConversationService` |
| `apps/bot-core/test/conversation.service.test.ts` | CREATE | 6 unit tests for `loadHistory` (window boundaries, LIMIT cap, ordering, empty, MySQL throw → `[]`) |
| `apps/bot-core/src/queue/message.processor.ts` | MODIFY | Inject `ConversationService`; call before router; populate `ctx.history` |
| `apps/bot-core/src/queue/worker.module.ts` | MODIFY | Add `ConversationModule` to imports; construct `MessageProcessor` with the service |
| `apps/bot-core/test/message.processor.test.ts` | MODIFY (extend) | 2 new cases: history passed to router ctx; history passed to handler ctx |
| `apps/bot-core/test/llm.handler.history.test.ts` | CREATE | 3 cases: history of N turns → messages array has N+1 entries in correct order; empty history → 2 entries (system + user); preserved role/content |
| `CHANGELOG.md` | MODIFY | Add `v0.2.0 — 2026-07-04` entry |

**Schema:** UNCHANGED. The `messages` table already has `role`, `content`, `created_at`, `platform`, `chat_id`, `sender_id` columns.

---

### Task 1: ConversationService

**Files:**
- Create: `apps/bot-core/src/conversation/conversation.service.ts`
- Create: `apps/bot-core/src/conversation/conversation.module.ts`
- Create: `apps/bot-core/test/conversation.service.test.ts`

**Interfaces:**
- Consumes: `mysql2/promise` `Pool` (injected via constructor), `@mpcb/shared` types for `PlatformName`
- Produces: `ConversationService` class with method `loadHistory(platform, chatId, senderId, now): Promise<Array<{role: 'user'|'assistant'|'system'; content: string}>>`

- [ ] **Step 1: Write the failing tests**

Create `apps/bot-core/test/conversation.service.test.ts`:

```ts
import { ConversationService } from '../src/conversation/conversation.service';

function makeService(impl: (sql: string, params: unknown[]) => Promise<unknown>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool: any = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return impl(sql, params);
    },
  };
  const logger: any = { warn: jest.fn(), error: jest.fn() };
  const svc = new ConversationService(pool, logger);
  return { svc, queries, logger };
}

const baseRow = (over: Partial<{ role: string; content: string; created_at: Date }> = {}) => ({
  role: 'user',
  content: 'hi',
  created_at: new Date('2026-07-04T10:00:00Z'),
  ...over,
});

describe('ConversationService.loadHistory', () => {
  const NOW = new Date('2026-07-04T10:30:00Z').getTime();

  it('returns empty array when no rows', async () => {
    const { svc, queries } = makeService(async () => [[]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('FROM messages');
    expect(queries[0].sql).toContain('ORDER BY created_at DESC');
    expect(queries[0].sql).toContain('LIMIT');
    expect(queries[0].params).toEqual(['wechat', 'c1', 'u1', 'u1', 'bot', 20]);
  });

  it('returns rows ascending when all within 30min window', async () => {
    const t0 = new Date('2026-07-04T10:00:00Z');
    const t1 = new Date('2026-07-04T10:05:00Z');
    const t2 = new Date('2026-07-04T10:10:00Z');
    // rows come DESC from MySQL
    const { svc } = makeService(async () => [[
      baseRow({ role: 'assistant', content: 'c', created_at: t2 }),
      baseRow({ role: 'user', content: 'b', created_at: t1 }),
      baseRow({ role: 'assistant', content: 'a', created_at: t0 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]);
  });

  it('breaks window at first turn older than 30min from its newer neighbor', async () => {
    // Walk DESC: newest is at t=10:25 (5min ago), then t=10:10 (15min from t=10:25),
    // then t=09:30 (40min from t=10:10) — break here.
    const t0 = new Date('2026-07-04T10:25:00Z');
    const t1 = new Date('2026-07-04T10:10:00Z');
    const t2 = new Date('2026-07-04T09:30:00Z');
    const { svc } = makeService(async () => [[
      baseRow({ role: 'user', content: 'recent', created_at: t0 }),
      baseRow({ role: 'assistant', content: 'mid', created_at: t1 }),
      baseRow({ role: 'user', content: 'old', created_at: t2 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([
      { role: 'assistant', content: 'mid' },
      { role: 'user', content: 'recent' },
    ]);
  });

  it('returns empty when most-recent row is older than 30min', async () => {
    const t0 = new Date('2026-07-04T09:30:00Z'); // 60min ago
    const { svc } = makeService(async () => [[
      baseRow({ created_at: t0 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
  });

  it('caps at HISTORY_LIMIT=10 turns', async () => {
    // 15 rows all within window. Expect 10.
    const rows = Array.from({ length: 15 }, (_, i) =>
      baseRow({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, created_at: new Date(NOW - (15 - i) * 60_000) }),
    );
    // ASC for clarity (DESC reordering is tested above); the service expects DESC input
    rows.reverse();
    const { svc } = makeService(async () => [[rows]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ role: expect.stringMatching(/user|assistant/), content: expect.any(String) });
  });

  it('returns empty array and logs warn when MySQL throws', async () => {
    const { svc, logger } = makeService(async () => { throw new Error('db down'); });
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('history load failed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/bot-core && pnpm test -- --testPathPattern=conversation.service`
Expected: FAIL — `Cannot find module '../src/conversation/conversation.service'`.

- [ ] **Step 3: Create the ConversationModule**

Create `apps/bot-core/src/conversation/conversation.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';

@Module({
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
```

- [ ] **Step 4: Implement ConversationService**

Create `apps/bot-core/src/conversation/conversation.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'mysql2/promise';
import { PlatformName } from '@mpcb/shared';

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

@Injectable()
export class ConversationService {
  private static readonly HISTORY_LIMIT = 10;
  private static readonly FETCH_LIMIT = 20;
  private static readonly SESSION_IDLE_MS = 30 * 60 * 1000;

  constructor(
    private readonly pool: Pool,
    @Inject('LOGGER') private readonly logger: { warn: (msg: string) => void; error: (msg: string) => void },
  ) {}

  async loadHistory(
    platform: PlatformName,
    chatId: string,
    senderId: string,
    now: number,
  ): Promise<ConversationTurn[]> {
    let rows: Array<{ role: 'user' | 'assistant' | 'system'; content: string; created_at: Date }>;
    try {
      const [result] = await this.pool.query<any[]>(
        `SELECT role, content, created_at FROM messages
         WHERE platform = ? AND chat_id = ? AND sender_id IN (?, 'bot')
         ORDER BY created_at DESC
         LIMIT ?`,
        [platform, chatId, senderId, senderId, 'bot', ConversationService.FETCH_LIMIT],
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
      const ts = new Date(row.created_at).getTime();
      if (i === 0) {
        if (ts < now - ConversationService.SESSION_IDLE_MS) break;
      } else {
        const prevTs = new Date(rows[i - 1].created_at).getTime();
        if (ts < prevTs - ConversationService.SESSION_IDLE_MS) break;
      }
      surviving.push({ role: row.role, content: row.content });
      if (surviving.length >= ConversationService.HISTORY_LIMIT) break;
    }

    surviving.reverse();
    return surviving;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/bot-core && pnpm test -- --testPathPattern=conversation.service`
Expected: 6 tests pass.

- [ ] **Step 6: Run full suite to verify no regressions**

Run: `pnpm -r test`
Expected: 89 + 6 = 95 tests pass; no regressions.

- [ ] **Step 7: Commit**

```bash
cd /e/ToolDevelop/MultiPlatformChatBot
git add apps/bot-core/src/conversation apps/bot-core/test/conversation.service.test.ts
git commit -m "feat(conversation): ConversationService.loadHistory with 30min sliding window"
```

---

### Task 2: Wire ConversationService into MessageProcessor

**Files:**
- Modify: `apps/bot-core/src/queue/message.processor.ts` — add ConversationService to constructor; call `loadHistory` before router; populate `ctx.history`.
- Modify: `apps/bot-core/src/queue/worker.module.ts` — import ConversationModule; pass service to MessageProcessor constructor.
- Modify: `apps/bot-core/test/message.processor.test.ts` — extend with 2 new cases asserting history flows into router and handler ctx.

**Interfaces:**
- Consumes: `ConversationService.loadHistory` from Task 1.
- Produces: `MessageProcessor` instances whose `process(msg)` populates `ctx.history` for both `router.route()` and `handler.handle()`.

- [ ] **Step 1: Extend message.processor.test.ts with history-flow cases**

In `apps/bot-core/test/message.processor.test.ts`, after the existing `'builds a 30s AbortSignal and forwards it to router and llm'` test (around line 133), append two new tests inside the same `describe('MessageProcessor', ...)` block:

```ts
  it('passes conversation history to router ctx (within session)', async () => {
    const { map } = makeAdapters('wechat');
    let routerHistory: any[] | undefined;
    const router = {
      route: async (_msg: any, ctx: any) => {
        routerHistory = ctx.history;
        return { kind: 'llm' as const, prompt: 'hi' };
      },
    };
    const llm = { handle: async () => ({ text: 'reply' }) };
    const conversation = {
      loadHistory: async () => [
        { role: 'user' as const, content: 'prev-q' },
        { role: 'assistant' as const, content: 'prev-a' },
      ],
    };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any);
    await proc.process(baseMsg({ msgId: 'mh1' }));
    expect(routerHistory).toEqual([
      { role: 'user', content: 'prev-q' },
      { role: 'assistant', content: 'prev-a' },
    ]);
  });

  it('degrades to empty history when ConversationService throws', async () => {
    const { map } = makeAdapters('wechat');
    let routerHistory: any[] | undefined;
    let llmHistory: any[] | undefined;
    const router = {
      route: async (_msg: any, ctx: any) => {
        routerHistory = ctx.history;
        return { kind: 'llm' as const, prompt: 'hi' };
      },
    };
    const llm = {
      handle: async (_d: any, ctx: any) => {
        llmHistory = ctx.history;
        return { text: 'reply' };
      },
    };
    const conversation = {
      loadHistory: async () => { throw new Error('db down'); },
    };
    const proc = new MessageProcessor(map, router as any, { llm, kb: {}, tool: {} } as any, noLog, conversation as any);
    const result = await proc.process(baseMsg({ msgId: 'mh2' }));
    expect(result.reply.text).toBe('reply');          // worker still completes
    expect(routerHistory).toEqual([]);                  // router sees empty history
    expect(llmHistory).toEqual([]);                     // handler sees empty history
  });
```

- [ ] **Step 2: Update the constructor signature in message.processor.ts**

In `apps/bot-core/src/queue/message.processor.ts`:

Replace the `constructor` block (lines 22-27):

```ts
  constructor(
    private readonly adapters: Map<PlatformName, PlatformAdapter>,
    private readonly router: RouterService,
    private readonly handlers: { llm: LlmHandler; kb: KbHandler; tool: ToolRegistry },
    private readonly messageLog: MessageLogService,
    private readonly conversation: ConversationService,
  ) {}
```

Add the import at the top (alongside the existing `@mpcb/shared` import):

```ts
import { ConversationService } from '../conversation/conversation.service';
```

- [ ] **Step 3: Call loadHistory and populate ctx.history**

In `apps/bot-core/src/queue/message.processor.ts`, replace `process(msg)` body — specifically the `await this.router.route(...)` call site — so it loads history first, then passes it both to the router and to the dispatch context:

```ts
  async process(msg: NormalizedMessage): Promise<ProcessResult> {
    const abortSignal = AbortSignal.timeout(30_000);

    let history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    try {
      history = await this.conversation.loadHistory(
        msg.platform,
        msg.chatId,
        msg.senderId,
        Date.now(),
      );
    } catch (err) {
      this.logger.warn(`loadHistory threw; degrading to empty history: ${err instanceof Error ? err.message : String(err)}`);
      history = [];
    }

    const decision = await this.router.route(msg, {
      userId: msg.senderId,
      chatId: msg.chatId,
      platform: msg.platform,
      history,
      abortSignal,
    });

    const reply = await this.dispatch(decision, msg, abortSignal, history);
    // ... rest of process() unchanged ...
  }
```

And replace the `dispatch` method (lines 69-86) so its `ctx` carries the same `history`:

```ts
  private async dispatch(
    decision: RouteDecision,
    msg: NormalizedMessage,
    signal: AbortSignal,
    history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
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
        return { text: `命令 ${decision.handler} 收到,参数:${decision.args || '(无)'} (MVP 占位)` };
      case 'unknown':
        return { text: `无法理解:${decision.reason}` };
    }
  }
```

- [ ] **Step 4: Update existing tests' constructor calls**

In `apps/bot-core/test/message.processor.test.ts`, every existing `new MessageProcessor(map, router as any, { llm, kb, tool } as any, noLog)` call (5 occurrences at lines 38, 54, 68, 81, 93, 104, 127) needs a 5th argument. Since the existing tests don't exercise history-dependent behavior, add a stub at the top of the `describe` block:

```ts
  const noConversation = { loadHistory: async () => [] } as any;
```

Then update each constructor call to append `, noConversation`. There are 7 calls; do each.

- [ ] **Step 5: Wire ConversationModule into WorkerModule**

In `apps/bot-core/src/queue/worker.module.ts`:

Add the import (with the other imports around line 16-17):

```ts
import { ConversationModule, ConversationService } from '../conversation/conversation.module';
import { conversationServiceFromPool } from '../conversation/conversation.factory';
```

Add `ConversationModule` to the `imports` array (line 21):

```ts
  imports: [QueueModule, HandlersModule, RouterModule, PlatformModule, MessagesModule, ConversationModule],
```

Inject `ConversationService` into the constructor (line 27-36, after `messageLog`):

```ts
    private readonly messageLog: MessageLogService,
    private readonly conversation: ConversationService,
  ) {}
```

Replace the `MessageProcessor` construction (lines 40-45) to pass the service:

```ts
    const processor = new MessageProcessor(
      adapterMap,
      this.router,
      { llm: this.llm, kb: this.kb, tool: this.tool },
      this.messageLog,
      this.conversation,
    );
```

- [ ] **Step 6: Run tests to verify all pass**

Run: `pnpm --filter @mpcb/bot-core test -- --testPathPattern=message.processor`
Expected: 9 tests pass (7 existing + 2 new).

Then: `pnpm -r test`
Expected: 95 + 2 = 97 tests pass; no regressions.

- [ ] **Step 7: Build to confirm types compile**

Run: `pnpm build`
Expected: build clean (shared, bot-core, admin-web all green).

- [ ] **Step 8: Commit**

```bash
cd /e/ToolDevelop/MultiPlatformChatBot
git add apps/bot-core/src/queue/message.processor.ts apps/bot-core/src/queue/worker.module.ts apps/bot-core/test/message.processor.test.ts
git commit -m "feat(worker): wire ConversationService into MessageProcessor"
```

---

### Task 3: LlmHandler history regression test + CHANGELOG + tag v0.2.0

**Files:**
- Create: `apps/bot-core/test/llm.handler.history.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: existing `LlmHandler.handle()` from `apps/bot-core/src/handlers/llm/llm.handler.ts:17-42`. No code change to LlmHandler.
- Produces: regression test that locks the existing `ctx.history.slice(-5)` behavior in.

- [ ] **Step 1: Create the LlmHandler history test**

Create `apps/bot-core/test/llm.handler.history.test.ts`:

```ts
import { LlmHandler } from '../src/handlers/llm/llm.handler';
import { HandlerContext } from '../src/handlers/handler.interface';

const baseCtx = (over: Partial<HandlerContext> = {}): HandlerContext => ({
  userId: 'u1',
  chatId: 'c1',
  platform: 'wechat',
  history: [],
  abortSignal: AbortSignal.timeout(30_000),
  ...over,
});

function makeHandler(capture: { messages?: any[] }) {
  const provider: any = {
    name: 'stub',
    defaultModel: 'm',
    chat: async (req: any) => {
      capture.messages = req.messages;
      return { text: 'reply', model: 'm', usage: { promptTokens: 1, completionTokens: 1 } };
    },
    countTokens: () => 1,
  };
  const usage: any = { record: async () => {} };
  return new LlmHandler(provider, usage);
}

describe('LlmHandler history propagation', () => {
  it('prepends ctx.history to messages and appends current user prompt', async () => {
    const cap: { messages?: any[] } = {};
    const handler = makeHandler(cap);
    const ctx = baseCtx({
      history: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    });
    await handler.handle({ kind: 'llm', prompt: 'q3' } as any, ctx);
    expect(cap.messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
    ]);
  });

  it('emits only [system?, user] when history is empty (single-turn)', async () => {
    const cap: { messages?: any[] } = {};
    const handler = makeHandler(cap);
    const ctx = baseCtx({ history: [] });
    await handler.handle({ kind: 'llm', prompt: 'hi' } as any, ctx);
    // First entry is system (or first history turn); then user prompt.
    // With empty history the messages array has length 1 (just the current user prompt),
    // matching the LlmHandler.handle() implementation.
    expect(cap.messages).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('caps history slice to last 5 entries before appending current prompt (matches existing slice(-5) in handler)', async () => {
    const cap: { messages?: any[] } = {};
    const handler = makeHandler(cap);
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    const ctx = baseCtx({ history });
    await handler.handle({ kind: 'llm', prompt: 'NOW' } as any, ctx);
    // slice(-5) yields the last 5 history entries (m5..m9), then current prompt 'NOW' → 6 messages.
    expect(cap.messages).toHaveLength(6);
    expect(cap.messages![5]).toEqual({ role: 'user', content: 'NOW' });
    expect(cap.messages!.slice(0, 5).map((m: any) => m.content)).toEqual(['m5', 'm6', 'm7', 'm8', 'm9']);
  });
});
```

Note: this test pins the existing `slice(-5)` behavior in `LlmHandler.handle()`. If the v0.2 spec wants to widen the slice to N=10 to match `HISTORY_LIMIT`, that is a one-line edit to `llm.handler.ts:22` (`slice(-5)` → no slice). The test currently asserts the OLD behavior; do not change the handler in this plan. Document this as a follow-up if v0.3 wants tighter alignment.

- [ ] **Step 2: Run the new test**

Run: `pnpm --filter @mpcb/bot-core test -- --testPathPattern=llm.handler.history`
Expected: 3 tests pass.

- [ ] **Step 3: Run full suite**

Run: `pnpm -r test`
Expected: 97 + 3 = 100 tests pass; no regressions.

- [ ] **Step 4: Update CHANGELOG.md**

In `CHANGELOG.md`, insert a new entry at the top (before `## v0.1.1 — 2026-07-04`):

```markdown
## v0.2.0 — 2026-07-04

Multi-turn conversation context for the LLM handler.

- New `ConversationService` reads `(platform, chat_id, sender_id)` rows from the `messages` table, applies a 30-minute sliding-window filter, and returns the last 10 turns in ascending order.
- `MessageProcessor` calls `loadHistory` before dispatch and populates `ctx.history` for both the router and the handler.
- LLM handler now sees prior turns within an active session and can reference earlier messages.
- KB and Tool handlers unchanged (no behavior change vs v0.1.1).
- MySQL-down / load-failure: degrades to empty history (single-turn behavior), warning logged.
- Sessions: `(platform, chat_id, sender_id)` — different users in the same group get independent contexts.
- Cross-session: after 30 minutes of inactivity, the bot starts fresh (intentional).

Tests: 100/100 across 27 suites (was 89/89 in v0.1.1; +11).
```

- [ ] **Step 5: Build final pass**

Run: `pnpm build && pnpm -r lint`
Expected: both green.

- [ ] **Step 6: Commit + tag**

```bash
cd /e/ToolDevelop/MultiPlatformChatBot
git add apps/bot-core/test/llm.handler.history.test.ts CHANGELOG.md
git commit -m "feat(llm): regression test for history propagation; docs: v0.2.0 release notes"
git tag v0.2.0
```

- [ ] **Step 7: Push to GitHub**

```bash
git push origin master --tags
```

Verify with: `git ls-remote --tags origin | grep v0.2.0`
Expected: tag visible on origin.

---

## Spec Coverage Self-Check

| Spec section | Covered by |
|---|---|
| §2.1 Decisions Recap | All 5 decisions baked into Task 1 (constants and SQL) and Task 2 (wiring). |
| §2.2 Reuse of v0.1.1 | Task 1 reads `messages` table; Task 2 reuses `MessageProcessor` and pool. |
| §2.3 Module Structure | `conversation` module (Task 1), `queue` MODIFIED (Task 2), `handler-llm` covered by existing `ctx.history` consumption (Task 3 regression test). |
| §3.1 Worker Flow | Task 2 step 3 implements the flow exactly. |
| §3.2 LLM Request Construction | Pre-existing in `llm.handler.ts:21-24`; locked in by Task 3. |
| §3.3 Session Window Logic | Task 1 step 4 implements the algorithm. Tests in Task 1 step 1 cover the boundaries. |
| §4.1 ConversationService | Task 1 step 4. |
| §4.2 MessageProcessor | Task 2 step 3. |
| §4.3 LlmHandler | No code change required; Task 3 covers with regression test. |
| §4.4 Shared types | Not needed — existing `RouteContext.history` and `HandlerContext.history` already carry the shape. |
| §5 Failure Modes | Empty history case covered by Task 1 test #1 + Task 2 test 'degrades to empty history'. MySQL throw covered by Task 1 test #6. |
| §6 Testing Strategy | All 11 test cases added (6 in Task 1, 2 in Task 2, 3 in Task 3). |

## Plan Self-Review Notes

1. **Spec coverage:** Every numbered section in the spec maps to a step above. No gaps.
2. **Placeholder scan:** No TBDs. All values exact (`HISTORY_LIMIT = 10`, `FETCH_LIMIT = 20`, `30 * 60 * 1000` ms, SQL table `messages`, column `sender_id`, etc.).
3. **Type consistency:** `ConversationTurn` shape matches the inline `history` shape on `RouteContext` / `HandlerContext` (`{ role, content }`). No new shared type needed because the existing interfaces already declare the right shape.
4. **Ambiguity:** Window logic uses "gap from newer neighbor" — documented in Task 1 step 1 test #3 ('breaks window at first turn older than 30min from its newer neighbor').

---

*End of plan*