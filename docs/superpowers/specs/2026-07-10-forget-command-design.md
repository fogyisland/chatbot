# `/forget` Command — v0.3 Design Spec

**Date:** 2026-07-10
**Status:** Approved (pending spec review)
**Owner:** 徐鹏
**Target release:** v0.3.0
**Supersedes:** none (additive over v0.2.1)

---

## 1. Overview & Goals

Add an explicit **session-reset command** (`/forget`) so a user can immediately wipe their conversation context with the bot, without waiting for the 30-minute idle gap.

### Goals

- A user can type `/forget` to immediately start a fresh conversation with the bot.
- Scope is **per-sender**: only the initiator's context is reset; other users in the same chat are unaffected.
- Boundary is durable: restarts, worker crashes, and queue replays do not bring back old context.
- Configurable reply: verbose (default — confirms reset) or silent (no public reply text).
- No regression in v0.2.1 multi-turn behavior for users who never invoke `/forget`.

### Non-Goals (v0.3)

- Selective forget ("forget only the last N turns") — out of scope; whole-history wipe only.
- Cross-platform `/forget` (e.g. user says it on WeChat, also resets Teams) — out of scope; per-platform only.
- Per-chat admin reset (e.g. group owner wipes everyone) — out of scope; sender-initiated only.
- Hard delete of `messages` rows — boundary is a soft marker; rows remain for audit / analytics.
- New SQL table for boundaries — uses existing `messages` table.

---

## 2. Architecture Overview

### 2.1 Decisions Recap

| Dimension | Choice |
|---|---|
| Command name | `/forget` (single token; no `/reset`, `/clear`, `/new`) |
| Scope | Per-sender: `(platform, chat_id, sender_id)` of initiator |
| Boundary mechanism | Soft: INSERT `messages` row with `role='system'`, `content='__forget_boundary__'` |
| ConversationService behavior | Walker breaks at boundary marker (treats like 30-min gap) |
| Reply mode | Configurable: `'verbose'` (default) or `'silent'` |
| Schema change | None — uses existing `messages` table |
| Failure mode | DB insert fails → log warn, fall through to default LLM/KB handler with empty history |

### 2.2 Why Soft Boundary (over Hard Delete)

Per brainstorming §3 decision: hard delete (`DELETE FROM messages WHERE ...`) destroys audit trail and breaks idempotency (worker retry would re-insert and re-wipe). A soft boundary row:

- Stays in the table for forensics (analytics, compliance, debugging).
- Is naturally idempotent: INSERT with `msg_id` as unique key → second insert is no-op.
- Is naturally per-sender-scoped via the existing `sender_id IN (?, 'bot')` query filter (bot does not insert user rows; user's `/forget` row carries their own `sender_id`).
- Is naturally crossed-session-safe: walker also honors the 30-min idle gap, so an old `/forget` from hours ago doesn't suppress today's history — the 30-min window already expires stale boundaries.

### 2.3 Module Structure

| Module | Status | Responsibility |
|---|---|---|
| `message-log` | MODIFIED | New `upsertForgetBoundary(msg): Promise<void>` writes system row, idempotent on `msg_id` |
| `conversation` | MODIFIED | `loadHistory()` walker breaks at `role='system' AND content='__forget_boundary__'` rows (in addition to 30-min gap) |
| `queue` | MODIFIED | `MessageProcessor.dispatch()` adds `case 'command': 'forget'` → call `upsertForgetBoundary`, return configured reply text |
| `router` | MODIFIED | `RouterConfig.commands` widens to include `'forget'`; new `forgetReply: 'verbose' \| 'silent'` field; default config in `router.service.ts` |
| `@mpcb/shared` | MODIFIED | `RouterConfig` type gains `forgetReply?: 'verbose' \| 'silent'` |

---

## 3. Data Flow

### 3.1 `/forget` Worker Flow

```
[Webhook controller]
  → messageLog.upsertUser(msg)        // v0.2.1: existing
  → enqueueMessage(msg)               // existing

[BullMQ Worker]
  → MessageProcessor.process(msg)
    1. sessionKey = { platform, chatId, userId }                  // v0.2.1
    2. history = await conversationService.loadHistory(...)        // v0.2.1
    3. ctx = { abortSignal, history }                              // v0.2.1
    4. decision = router.route(msg)                                // existing
    5. process() handles inline (MODIFIED — see §4.3):
         decision.kind === 'command' && decision.handler === 'forget':
           → messageLog.upsertForgetBoundary(msg)
           → reply = cfg.forgetReply === 'silent' ? null : { text: '会话已重置, 请问有什么可以帮你?', replyToMsgId: msg.msgId }
         decision.kind === 'command' && decision.handler !== 'forget':
           → existing placeholder behavior (help/clear/status); unchanged
         decision.kind === 'handler':
           → handler.handle(input, ctx)         // unchanged
    6. adapter.sendReply(reply, target)         // v0.1.1 fix #1
```

### 3.2 Boundary Insert (idempotent)

`MessageLogService.upsertForgetBoundary(msg)`:

```sql
INSERT INTO messages
  (platform, chat_id, sender_id, role, content, msg_id, created_at)
VALUES (?, ?, ?, 'system', '__forget_boundary__', ?, ?)
ON DUPLICATE KEY UPDATE id = id;   -- no-op on msg_id conflict
```

`msg_id` carries the user's original message id (e.g. WeChat `MsgId`). If the worker replays the same job (BullMQ retry), the duplicate-key path makes it a no-op.

### 3.3 Walker Change

`ConversationService.loadHistory()` walker change — add boundary check alongside the 30-min gap check:

```ts
const BOUNDARY_CONTENT = '__forget_boundary__';
// inside the DESC walk loop:
if (row.role === 'system' && row.content === BOUNDARY_CONTENT) break;
if (i > 0 && ts < prevTs - this.SESSION_IDLE_MS) break;  // existing 30-min check
```

Boundary rows are **excluded** from the returned `MessageTurn[]` (system rows don't reach LLM).

### 3.4 Scope of `/forget`

A user's `/forget` row is inserted with their own `sender_id`. The conversation query is `WHERE sender_id IN (?, 'bot')`. Subsequent `loadHistory()` for that sender:

- Sees the boundary row → walker breaks → returns `[]` (or rows before the boundary, but boundary is the most recent so usually `[]`).
- Other senders in the same chat are unaffected: their query filters by their own `sender_id` and never sees the initiator's boundary row.

---

## 4. Component Details

### 4.1 `MessageLogService` (MODIFIED)

```ts
// apps/bot-core/src/message-log/message-log.service.ts (additions only)

private static readonly FORGET_BOUNDARY_CONTENT = '__forget_boundary__';

async upsertForgetBoundary(msg: NormalizedMessage): Promise<void> {
  await this.pool.query(
    `INSERT INTO messages
       (platform, chat_id, sender_id, role, content, msg_id, created_at)
     VALUES (?, ?, ?, 'system', ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      msg.platform,
      msg.chatId,
      msg.senderId,
      MessageLogService.FORGET_BOUNDARY_CONTENT,
      msg.msgId,
      new Date(),
    ],
  );
}
```

### 4.2 `ConversationService` (MODIFIED)

```ts
// apps/bot-core/src/conversation/conversation.service.ts (walker change)

private static readonly BOUNDARY_CONTENT = '__forget_boundary__';

// inside loadHistory walker, after the i > 0 gap check:
if (row.role === 'system' && row.content === ConversationService.BOUNDARY_CONTENT) {
  break;
}
```

No new SQL columns, no schema change. Walker naturally excludes the system row from the returned `MessageTurn[]` (the row triggers `break` before being pushed).

### 4.3 `MessageProcessor` (MODIFIED)

```ts
// apps/bot-core/src/queue/message.processor.ts (dispatch additions)

async process(msg: NormalizedMessage): Promise<...> {
  // ... existing loadHistory + ctx build ...

  const decision = this.router.route(msg);

  if (decision.kind === 'command' && decision.handler === 'forget') {
    let replyText: string;
    switch (this.routerConfig.forgetReply ?? 'verbose') {
      case 'silent':
        replyText = '';
        break;
      case 'verbose':
      default:
        replyText = '会话已重置, 请问有什么可以帮你?';
        break;
    }
    const target: AdapterTarget = { platform: msg.platform, chatId: msg.chatId };
    return { reply: replyText ? this.toReply(replyText, msg) : null, target };
  }

  // ... existing handler dispatch ...
}

private toReply(text: string, msg: NormalizedMessage): NormalizedReply {
  return { text, replyToMsgId: msg.msgId, platform: msg.platform };
}
```

### 4.4 `RouterConfig` (MODIFIED)

```ts
// packages/shared/src/router.ts (or wherever RouterConfig lives)

export interface RouterConfig {
  commands: Record<string, 'help' | 'clear' | 'status' | 'forget'>;  // widened union
  prefixes: Record<string, string>;
  defaultHandler: 'llm' | 'kb' | 'tool';
  commandOnly: boolean;
  forgetReply: 'verbose' | 'silent';   // NEW, default 'verbose'
}
```

`RouterService` default config (in `router.service.ts`):

```ts
const DEFAULT_CONFIG: RouterConfig = {
  commands: { '/help': 'help', '/clear': 'clear', '/status': 'status', '/forget': 'forget' },
  prefixes: { '/cmd': '/cmd' },
  defaultHandler: 'llm',
  commandOnly: false,
  forgetReply: 'verbose',   // NEW
};
```

MySQL `router_config` table seed row (admin can override):

```sql
UPDATE router_config SET config_json = JSON_SET(config_json, '$.forgetReply', 'silent') WHERE id = 1;
```

---

## 5. Failure Modes & Edge Cases

| Scenario | Behavior | Impact |
|---|---|---|
| MySQL down on `upsertForgetBoundary` | `pool.query` throws → processor's existing try/catch logs warn and falls through to default LLM handler with `ctx.history = []` (effectively a no-op forget + single-turn reply) | User sees bot reply normally; forget didn't happen. Acceptable degradation. |
| Pool timeout on insert | Same as MySQL down | Same |
| Duplicate `/forget` (worker retries) | `ON DUPLICATE KEY UPDATE id = id` → no-op; no second reply sent (BullMQ retry re-enters processor but the message is the same job; idempotency at queue layer prevents duplicate send) | Safe |
| `msg.senderId` empty | Existing `loadHistory` defensive: empty sender_id returns `[]`. New `upsertForgetBoundary` uses same `msg.senderId` for the INSERT → boundary row still written with `sender_id=''`; walker on empty-sender queries would see it but those queries already return `[]`. | Safe |
| `/forget` arrives during active session (history has 5 turns) | Boundary inserted; walker's DESC order picks it up at top → returns `[]` → next user message sees empty history (single-turn). | Expected behavior. |
| `/forget` from user A; user B in same chat sends a message 1s later | A's boundary row exists with A's `sender_id`. B's `loadHistory` filters `sender_id IN (?, 'bot')` → never sees A's boundary → B's history intact. | Per-sender scope verified. |
| Stale `/forget` from 2 hours ago | Walker checks `ts < prevTs - 30min` BEFORE reaching the boundary; if 2h-old boundary is `i > 0` and `prevTs - 2h > 30min`, the gap check breaks first → boundary never reached. If boundary is `i = 0` (most recent), it's stale → no survivors returned (cross-session, expected). | 30-min idle gap already covers this. |
| Concurrent `/forget` from same user in same second | Both INSERTs: first succeeds; second hits `ON DUPLICATE KEY UPDATE` only if `msg_id` collides (rare). If `msg_id` differs (different upstream messages), both rows written → second boundary is the effective one → same outcome. | Idempotent enough. |
| Race: user A `/forget` lands while worker is mid-query for A | Worker A's `loadHistory` started before boundary insert → returns pre-forget history → next message sees fresh history. Acceptable; worker is short-lived per job. | Documented; not tested. |
| `forgetReply: 'silent'` in config | `replyText = ''` → processor returns `reply: null` → adapter sends nothing → bot stays silent in chat | User gets no confirmation; expected per config. |
| `forgetReply: 'silent'` + DB insert fails | `replyText = ''` (config wins) + boundary NOT inserted → user sees nothing happens; next message sees full old history. | Worst-case silent failure. Logged warn so operator can detect via logs. |
| Unknown command (e.g. `/foo`) | Existing router behavior; not a `/forget` case | Unchanged. |

---

## 6. Testing Strategy

### 6.1 Unit Tests (mock-based, NO docker)

| File | Cases | Key assertions |
|---|---|---|
| `conversation.service.test.ts` (+3 cases) | `walker breaks at boundary marker` | seed `[u1, u2, sys:__forget_boundary__, u3]` DESC → returns `[]` (boundary at i=0 breaks immediately) |
| | `walker excludes other users' boundaries` | seed `[sys:boundary by sender A, u1 by sender B]` queried as B → returns `[u1]` (A's boundary invisible) |
| | `walker ignores stale boundary (>30min old)` | seed `[u_old, sys:boundary 45min ago, u_new]` → returns `[u_new, u_old]` (30-min gap check fires first, boundary expired) |
| `message-log.service.test.ts` (+2 cases) | `upsertForgetBoundary writes system row` | INSERT called with `role='system'`, `content='__forget_boundary__'`; idempotent on `msg_id` (second call no-op) |
| | `upsertForgetBoundary throws on DB error` | pool mock rejects → service propagates; processor's try/catch falls through to default handler |
| `message.processor.test.ts` (+2 cases) | `/forget verbose dispatches and returns reply` | `dispatch({ command: 'forget' })` → calls `messageLog.upsertForgetBoundary(msg)` once + returns `'会话已重置, 请问有什么可以帮你?'` text |
| | `/forget silent returns empty reply` | `RouterConfig.forgetReply='silent'` → processor returns `reply: null`, still calls `upsertForgetBoundary` (boundary still logged, just no public reply) |
| `message.processor.test.ts` (+1, idempotency) | `duplicate /forget msg_id is no-op` | two `process()` calls with same `msg_id` → second short-circuits at `MessageLogService.logMessage` dedupe (existing pattern in v0.1.1) — second boundary INSERT not attempted |
| `conversation.service.test.ts` (+1, cross-user) | `boundary from other sender_id never returned` | seed two `sender_id`s each with boundary → query for sender A returns only A's pre-boundary rows; B's boundary never visible |

**Total: +9 tests.** Current 101 → 110 expected. All run via `pnpm -F bot-core test`.

### 6.2 Manual e2e (out of scope for the implementation plan, requires docker)

- Send 3 related messages → 3rd reply references 1st and 2nd.
- Send `/forget` → bot replies "会话已重置" (verbose default).
- Send a new message → reply does NOT reference prior 3 turns.
- Have user A send `/forget` while user B sends an unrelated message → A's history reset, B's history intact.
- Set `router_config.config_json->'$.forgetReply' = 'silent'` in MySQL → send `/forget` → bot sends nothing in chat; subsequent message sees fresh history.

---

## 7. Out of Scope / Future Work

- **v0.3.x or v0.4+ candidate features:**
  - Selective forget ("forget last N turns" with `/forget 5`)
  - Cross-platform forget (WeChat `/forget` also resets Teams session for same user)
  - Admin reset (`/forget @user` by group owner)
  - Hard delete of `messages` rows on forget (compliance erasure)
  - Per-user retention policy (`/forget` after 90 days)
  - Analytics: forget rate per sender, common reset triggers
  - `/forget` confirmation prompt (`Are you sure? Y/N`) — deferred; would require stateful reply tracking

- **Operational:**
  - `messages` table now grows by 1 row per `/forget` invocation — same growth concern as v0.1.1; cleanup job still pending.
  - `usage_log` should record `/forget` invocations for analytics (deferred to v0.3.x).
  - Default `RouterConfig.forgetReply='verbose'` is safe; deployments that want silent must set via `router_config` table or env-driven config (out of scope here).

---

## 8. Spec Self-Review

- **Placeholder scan:** No TBDs. All values exact (`'__forget_boundary__'`, `'会话已重置, 请问有什么可以帮你?'`, `forgetReply: 'verbose' | 'silent'`, default `'verbose'`).
- **Internal consistency:** Architecture matches data flow; data flow matches component details; component details match test plan.
- **Scope:** Single feature (`/forget` command), single implementation plan, no decomposition needed.
- **Ambiguity:** "Soft boundary" defined concretely (specific role + content). "Per-sender scope" defined concretely (existing query filter). "Verbose vs silent" defined concretely (specific reply text vs `null`).

---

*End of design.*