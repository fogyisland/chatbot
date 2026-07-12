# Changelog

## v0.3.0 — 2026-07-10

User-initiated conversation reset via `/forget`. Soft boundary: writes a `messages` row with `role='system'`, `content='__forget_boundary__'` keyed by the user's `msg_id` (idempotent). `ConversationService` walker now breaks at boundary markers, so the next user message after `/forget` sees an empty history (fresh conversation).

- New command `/forget` — resets the initiator's session only (per-`(platform, chat_id, sender_id)`); other users in the same chat are unaffected.
- New `MessageLogService.upsertForgetBoundary(msg)` — INSERT … ON DUPLICATE KEY UPDATE on `(platform, msg_id)`. Propagates errors (unlike `upsertUser`/`upsertAssistant`) so the processor knows whether the boundary landed.
- `ConversationService.loadHistory()` walker breaks at `role='system', content='__forget_boundary__'` rows in addition to the existing 30-min idle gap.
- `MessageProcessor.dispatch()` handles `decision.handler === 'forget'`: calls `upsertForgetBoundary`, then returns the reply per `RouterConfig.forgetReply`.
- New `RouterConfig.forgetReply: 'verbose' | 'silent'` field. Default `'verbose'` returns `会话已重置, 请问有什么可以帮你?`. `'silent'` returns an empty NormalizedReply (boundary still inserted, but no public reply).
- `RouteDecision` command-handler union widened to include `'forget'` in `packages/shared`.
- New `RouterService.getConfig()` accessor (uses the existing 60s cache) so the processor can read `forgetReply` per-message without re-fetching.
- DB error on boundary insert: logged warn + fallback to default LLM handler with the user's original text — user sees a normal reply, forget didn't happen (acceptable degradation).

Tests: 112/112 across 29 suites (was 101/101 in v0.2.1; +11: 6 ConversationService walker, 2 MessageLogService, 2 MessageProcessor, 1 router). `pnpm build` green. `pnpm -r lint` green.

## v0.2.1 — 2026-07-10

Post-review fixes over v0.2.0. The v0.2.0 tag pointed at a commit that crashes the worker on startup (DI graph could not resolve `ConversationService`'s `Pool` / `'LOGGER'` dependencies). All consumers should use v0.2.1 instead.

**Critical fix (production-startup blocker):**
- `ConversationService` constructor switched to the existing `MessageLogService` pattern: takes only `ConfigService`, owns a `new Logger(ConversationService.name)`, and lazy-allocates its `Pool` on first query. Worker now boots and resolves DI cleanly. New unit test asserts the service constructs via `Test.createTestingModule(...).compile()` (would have failed against v0.2.0).

**Behavioral fix:**
- `LlmHandler.handle()` no longer caps `ctx.history` at `slice(-5)`. Now consumes the full `HISTORY_LIMIT=10` from `ConversationService` per the v0.2 spec. Regression test updated accordingly.

**Schema fix:**
- New migration `0002_messages_session_index.sql` adds a composite index `idx_messages_session (platform, chat_id, sender_id, created_at)` so the `loadHistory` query is index-supported (was: full scan per query under worker concurrency).

**Docs:**
- `docs/superpowers/specs/2026-07-04-multi-turn-conversation-design.md` corrected to reference `sender_id` (the actual column name) instead of the never-existed `user_id`.

Tests: 101/101 across 29 suites (was 100/100 in v0.2.0; +1 NestJS DI construction test). `pnpm build` green. `pnpm -r lint` green.

> Note: the v0.2.0 tag remains at the buggy commit `809a753` for history; DO NOT use it in production. Use `v0.2.1` at `9146ce3` (or `master` HEAD).

## v0.2.0 — 2026-07-04

Multi-turn conversation context for the LLM handler.

- New `ConversationService` reads `(platform, chat_id, sender_id)` rows from the `messages` table, applies a 30-minute sliding-window filter, and returns the last 10 turns in ascending order.
- `MessageProcessor` calls `loadHistory` before dispatch and populates `ctx.history` for both the router and the handler.
- LLM handler now sees prior turns within an active session and can reference earlier messages.
- KB and Tool handlers unchanged (no behavior change vs v0.1.1).
- MySQL-down / load-failure: degrades to empty history (single-turn behavior), warning logged.
- Sessions: `(platform, chat_id, sender_id)` — different users in the same group get independent contexts.
- Cross-session: after 30 minutes of inactivity, the bot starts fresh (intentional).

Tests: 100/100 across 29 suites (was 89/89 in v0.1.1; +11).

## v0.1.1 — 2026-07-04

Post-review fixes over v0.1.0.

**Critical integration fixes (post-whole-branch review):**
- Worker now dispatches `adapter.sendReply(reply, target)` keyed by `msg.platform` (was: dead wiring — adapter never invoked).
- DLQ persistence: failed jobs now INSERT into `dlq_records` AND enqueue to the `message.dlq` BullMQ queue at retry exhaustion.
- Messages logging: new `MessageLogService` writes user rows at webhook intake and assistant rows in the worker (idempotent on `(platform, msg_id)`).
- nginx now preserves `/bot/` and `/admin/` path prefixes in `proxy_pass` (was: production webhook routing 4xx).

**Reliability and hygiene fixes:**
- AbortSignal: 30s timeout applied and propagated through LLM/KB handlers.
- Router config now loaded from MySQL `router_config` with a 60s in-memory cache; graceful fallback to defaults if DB unreachable.
- FallbackProvider `defaultModel` resolves to chain head (no longer empty string).
- CI: `pnpm -r lint` (real `tsc --noEmit`) runs before build steps.
- WeChat `accessToken` fetched on demand, cached for 7140s, refreshed on 40001/40014/42001.
- Tool rate-counter now window-resets with a 10k-entry lazy prune (was: unbounded growth).
- AdminController closes its MySQL pool on `onModuleDestroy`.
- AdminGuard reads token from `ConfigService` and fails closed if `NODE_ENV=production` with no token.

**Repo hygiene:**
- `.gitignore` hardened; `.nvmrc` pins Node 20.

Tests: 89/89 across 27 suites (was 77/77 across 25 in v0.1.0).

## v0.1.0 — 2026-06-29

Initial MVP release.

- Three platform adapters: WeChat Work, Microsoft Teams, DingTalk
- Hybrid replies: KB (RAG) + LLM (Claude/OpenAI/Tongyi/DeepSeek) + Tool
- Command/keyword routing with 5 priority levels
- BullMQ queue with 3-attempt exponential retry and DLQ
- MySQL schema (11 tables) for messages, KB, tool registry, usage log, DLQ
- Qdrant vector store for KB chunks (1024-dim, cosine)
- Admin REST API + Next.js web console (dashboard, messages, DLQ)
- Docker Compose deployment with Nginx reverse proxy
- GitHub Actions CI (lint + typecheck + tests)
