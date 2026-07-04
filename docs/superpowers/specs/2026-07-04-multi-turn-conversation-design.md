# Multi-Turn Conversation Context — v0.2 Design Spec

**Date:** 2026-07-04
**Status:** Approved (pending spec review)
**Owner:** 徐鹏
**Target release:** v0.2.0
**Supersedes:** none

---

## 1. Overview & Goals

Add **multi-turn conversation context** to the v0.1.1 chatbot so that the LLM handler can see prior turns within the same session, producing coherent multi-message conversations.

### Goals

- A user can hold a multi-turn conversation with the bot within a single session and have the bot reference earlier turns.
- Sessions are scoped per `(platform, chat_id, user_id)` — different users in the same chat get independent contexts.
- Conversation history is durable across restarts and worker crashes.
- Multi-turn behavior degrades gracefully: any storage failure reverts to single-turn without breaking the bot.
- No regression in KB / Tool handler paths — they remain single-turn.

### Non-Goals (v0.2)

- Cross-session memory (after the 30-minute idle gap, the bot starts fresh — by design).
- KB query expansion using history (KB handler does not see history in v0.2).
- Token-budget-aware truncation (last N=10 is the only window strategy).
- Sliding-window summarization of older turns.
- RAG over conversation history.
- Multi-tenant isolation of conversation history (single-tenant still).
- `/forget` or other explicit session reset (planned for v0.3).

---

## 2. Architecture Overview

### 2.1 Decisions Recap

| Dimension | Choice |
|---|---|
| Session ID | `(platform, chat_id, user_id)` |
| Storage | MySQL — existing `messages` table (no schema change) |
| Context window | Last N=10 user/assistant turns |
| Session boundary | 30 minutes of inactivity → new session |
| Affected handlers | LLM only — KB and Tool unchanged |
| Failure mode | Degrade to single-turn (empty history) |

### 2.2 Reuse of v0.1.1 Infrastructure

The `messages` table is already populated by `MessageLogService` (per v0.1.1 fix #3: every user message logged at webhook intake, every assistant reply logged in the worker). For multi-turn context, we read from the same table.

Schema unchanged:

```
messages(id, platform, chat_id, user_id, role, content, msg_id, created_at, ...)
```

For session-context queries we only need: `platform`, `chat_id`, `user_id`, `role`, `content`, `created_at`.

### 2.3 Module Structure

| Module | Status | Responsibility |
|---|---|---|
| `conversation` | NEW | `ConversationService.loadHistory(sessionKey, now): Promise<MessageTurn[]>` |
| `queue` | MODIFIED | `MessageProcessor` injects `ConversationService`, builds `ctx.conversationHistory` before handler dispatch |
| `handler-llm` | MODIFIED | `LlmHandler.handle()` prepends `ctx.conversationHistory` to `LlmRequest.messages` |
| `handler-kb` | unchanged | ignores `ctx.conversationHistory` |
| `handler-tool` | unchanged | ignores `ctx.conversationHistory` |
| `@mpcb/shared` | MODIFIED | new `MessageTurn` type; `HandlerContext` extended with `conversationHistory?: MessageTurn[]` |

---

## 3. Data Flow

### 3.1 Worker Flow (v0.2)

```
[Webhook controller]
  → messageLog.upsertUser(msg)        // v0.1.1
  → enqueueMessage(msg)               // existing

[BullMQ Worker]
  → MessageProcessor.process(msg)
    1. [NEW] sessionKey = { platform, chatId, userId }
    2. [NEW] history = await conversationService.loadHistory(sessionKey, now)
    3. [NEW] ctx = { abortSignal, conversationHistory: history }
    4. router.route(msg)              // existing
    5. handler.handle(input, ctx)     // existing; LlmHandler uses history
    6. messageLog.upsertAssistant(reply)   // v0.1.1
    7. adapter.sendReply(reply, target)    // v0.1.1 fix #1
```

### 3.2 LLM Request Construction

`LlmHandler.handle()` builds `LlmRequest.messages`:

```
[
  ...ctx.conversationHistory.map(t => ({ role: t.role, content: t.content })),
  { role: 'user', content: msg.content }
]
```

The system prompt (if any) and KB context (if any) are appended by the existing code path. Provider sees one messages array.

### 3.3 Session Window Logic

`ConversationService.loadHistory(platform, chatId, userId, now)`:

1. `SELECT role, content, created_at FROM messages WHERE platform=? AND chat_id=? AND user_id=? ORDER BY created_at DESC LIMIT <fetchLimit>` (default `fetchLimit = 20`, i.e. 2× N).
2. Walk results from newest to oldest. Track the most recent `created_at`. Continue while `current.created_at >= previous.created_at - 30min`. Stop at the first turn that breaks the window.
3. Reverse the surviving slice to time-ascending order and return.

Edge cases:

- Zero rows → return `[]`.
- All rows within 30min → return up to 10 newest (cap by `historyLimit`).
- Single row → return it if it is the current incoming message (already enqueued); otherwise empty.
- The CURRENT incoming message may not be in the DB yet (enqueued but worker hasn't reached `upsertUser` — actually `upsertUser` runs in the webhook controller BEFORE `enqueueMessage`, so by the time the worker queries, the user row exists). Verified.

---

## 4. Component Details

### 4.1 `ConversationService` (NEW)

```ts
// apps/bot-core/src/conversation/conversation.service.ts
export interface MessageTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: number;       // epoch ms
}

export interface SessionKey {
  platform: PlatformName;
  chatId: string;
  userId: string;
}

@Injectable()
export class ConversationService {
  private readonly HISTORY_LIMIT = 10;
  private readonly FETCH_LIMIT = 20;          // 2× HISTORY_LIMIT for window filtering
  private readonly SESSION_IDLE_MS = 30 * 60 * 1000;

  constructor(
    private readonly pool: Pool,              // mysql2 pool from worker.module
    private readonly logger: PinoLogger,
  ) {}

  async loadHistory(key: SessionKey, now: number = Date.now()): Promise<MessageTurn[]> {
    let rows: RowDataPacket[];
    try {
      const [result] = await this.pool.query<RowDataPacket[]>(
        `SELECT role, content, created_at FROM messages
         WHERE platform = ? AND chat_id = ? AND user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        [key.platform, key.chatId, key.userId, this.FETCH_LIMIT],
      );
      rows = result;
    } catch (err) {
      this.logger.warn({ err, key }, 'conversation history load failed; degrading to single-turn');
      return [];
    }

    if (rows.length === 0) return [];

    // Walk newest-to-oldest, stop at first 30min gap
    const windowStart = now - this.SESSION_IDLE_MS;
    const surviving: MessageTurn[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ts = new Date(row.created_at).getTime();
      if (i === 0) {
        if (ts < windowStart) break;   // most recent is too old → no history
        surviving.push({ role: row.role, content: row.content, ts });
      } else {
        const prevTs = surviving[surviving.length - 1].ts;   // we are descending, so prev is newer
        if (ts < prevTs - this.SESSION_IDLE_MS) break;        // gap > 30min from newer neighbor
        surviving.push({ role: row.role, content: row.content, ts });
      }
      if (surviving.length >= this.HISTORY_LIMIT) break;
    }

    surviving.reverse();   // back to ascending
    return surviving;
  }
}
```

### 4.2 `MessageProcessor` (MODIFIED)

```ts
// apps/bot-core/src/queue/message.processor.ts (additions only)
async process(msg: NormalizedMessage): Promise<{ reply: NormalizedReply | null; target: AdapterTarget }> {
  const abortSignal = AbortSignal.timeout(30_000);   // v0.1.1 fix #5

  // NEW: load conversation history
  let conversationHistory: MessageTurn[] = [];
  try {
    conversationHistory = await this.conversation.loadHistory(
      { platform: msg.platform, chatId: msg.chatId, userId: msg.userId },
      Date.now(),
    );
  } catch (err) {
    this.logger.warn({ err, msgId: msg.msgId }, 'loadHistory threw; degrading');
    conversationHistory = [];
  }

  const ctx: HandlerContext = { abortSignal, conversationHistory };
  const decision = this.router.route(msg);
  // ... rest unchanged
}
```

### 4.3 `LlmHandler` (MODIFIED)

```ts
// apps/bot-core/src/handlers/llm/llm.handler.ts (relevant change)
const historyMessages = (ctx.conversationHistory ?? []).map(t => ({ role: t.role, content: t.content }));
const request: LlmRequest = {
  system: this.systemPrompt,
  model: this.provider.defaultModel,
  messages: [...historyMessages, { role: 'user', content: msg.content }],
  signal: ctx.abortSignal,   // v0.1.1 fix #5
};
```

KB and Tool handlers do not change — they never read `ctx.conversationHistory`.

### 4.4 `@mpcb/shared` Type Extensions

```ts
// packages/shared/src/conversation.ts (new file) OR extend existing types.ts
export interface MessageTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

// HandlerContext (existing) gains an optional field:
export interface HandlerContext {
  abortSignal: AbortSignal;
  conversationHistory?: MessageTurn[];   // NEW
}
```

---

## 5. Failure Modes & Edge Cases

| Scenario | Behavior | Impact |
|---|---|---|
| MySQL down | `loadHistory` throws → catch in `MessageProcessor` → `conversationHistory = []` | Degrades to single-turn. log warn. |
| Pool timeout | Same as MySQL down (timeout thrown out of `pool.query`) | Degrades to single-turn. |
| `messages` table empty for this session | `loadHistory` returns `[]` | First message in session behaves like v0.1.1. |
| Last message >30min ago | Walk stops at first row; surviving is empty | Cross-session behavior: bot does not see old context. |
| Same user sends 2 messages within 5s | Both enqueued; worker processes serially. Second sees first in history (since `upsertUser` is sync before enqueue, and `upsertAssistant` runs after handler). | One-turn "echo" only if first reply lands before second query — acceptable. |
| Token overflow | N=10 × ~200 字 ≈ 2k tokens. Plus system + KB + user ≈ <5k for most models | Acceptable for v0.2; can add token-cap later. |
| KB handler invocation | `ctx.conversationHistory` ignored | No behavior change vs v0.1.1. |
| Tool handler invocation | Same as KB | No behavior change. |
| `msg.userId` empty (shouldn't happen — adapters always set it) | Query returns `[]` for empty user_id — same as no-history | Defensive: loadHistory accepts empty userId. |

---

## 6. Testing Strategy

### 6.1 Unit Tests (mock-based, NO docker)

| Test file | Cases | Key assertions |
|---|---|---|
| `conversation.service.test.ts` (NEW) | 6 cases | 30-min window boundary: gap=29min same session, gap=31min new session; LIMIT 20 cap; ascending order; empty result for no rows; MySQL throw → return `[]`; timestamp conversion correct |
| `message.processor.test.ts` (extend existing) | 2 new cases | Mock `ConversationService` returns 3 turns → assert `ctx.conversationHistory.length === 3` and order preserved; `ConversationService` throws → assert `ctx.conversationHistory === []` and worker continues |
| `llm.handler.test.ts` (extend existing) | 3 new cases | history=3 → `provider.chat()` receives messages of length 4 (3 history + 1 user), in correct order; history=[] → messages length 2 (system + user); KB / Tool handler tests unchanged |

Total: +11 test cases. 89 + 11 = 100 tests expected.

### 6.2 Manual e2e (out of scope for the implementation plan, requires docker)

- Send 3 related messages in a WeChat group → 3rd reply references the first 2.
- Wait 35 minutes, send a new message → reply does NOT reference old context.
- Send messages in two different user IDs in same chat → each gets independent history.

---

## 7. Out of Scope / Future Work

- **v0.3+** candidate features:
  - Token-budget-aware truncation
  - Sliding-window summarization
  - RAG over conversation history
  - KB query expansion using history
  - `/forget` explicit session reset
  - Conversation-level analytics (avg session length, drop-off, etc.)
  - Per-user retention policy / data export for compliance

- **Operational:**
  - Cleanup job for old `messages` rows (current v0.1.1 stores everything forever — same concern as v0.1.1 ledger).
  - `usage_log` token tracking should now also reflect history-context cost.

---

## 8. Spec Self-Review

- **Placeholder scan:** No TBDs. All values exact (`N=10`, `FETCH_LIMIT=20`, `30 * 60 * 1000` ms, table name `messages`).
- **Internal consistency:** Architecture matches data flow; data flow matches component details; component details match test plan.
- **Scope:** Single feature (multi-turn context), single implementation plan, no decomposition needed.
- **Ambiguity:** "Session" defined concretely. "Last N turns" defined concretely. "Degrade to single-turn" defined concretely (history = []).

---

*End of design.*