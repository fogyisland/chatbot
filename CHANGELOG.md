# Changelog

## v0.6.0 — 2026-07-12

Sliding-window summarization for over-budget conversations. v0.5's FIFO drop is replaced by a single summary row per session that captures prior context; full history is never silently lost when the feature is on. Opt-in via `ENABLE_SUMMARIZATION` (default off; v0.5 deployments see zero behavior change).

**New env:**
- `ENABLE_SUMMARIZATION` (default `false`, boolean). Truthy: `1|true|yes|on`. Anything else → `false`.
- `SUMMARIZER_PROVIDERS` (default `claude-haiku,openai-mini`, csv). Ordered chain of provider-name strings. Each maps to a registered `LlmProvider` instance in the new `SummarizerModule`.
- `SUMMARIZER_CONTEXT_WINDOW` (default `100_000` tokens). Cheap-model safe default; controls the pre-trim input cap (`0.7 × contextWindow`).

**New APIs:**
- `SummarizationService.summarize(turns, signal) → Promise<string>` — builds the small-LLM request (system prompt + transcript), runs pre-trim to 70% of context window, tries each provider in the chain sequentially, records usage per provider.
- `SummarizationService.contextWindow` getter (parity with `LlmHandler.contextWindow`).
- `SummarizationUnavailableError extends Error` — typed failure when all chain providers fail. Carries `.cause`. Caller (MessageProcessor) catches + falls back to v0.5 `loadHistory` behavior (logged warn).
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
  4. On full-chain failure → `SummarizationUnavailableError` → caller falls back to v0.5 `loadHistory` path (logged warn). Doubly-fail-closed final state: empty history.
  5. Upsert summary row keyed on `summary-<sha1(sessionKey)>` (idempotent on next over-budget event for the same session).
  6. Return `[{ role: 'summary', content: merged }, ...recent_verbatim_turns]` to the LLM context.
- `/forget` semantics preserved: boundary walker's `role='system', content='__forget_boundary__'` check still precedes summary rows in DB; a session restart cleanly drops accumulated summaries.

**Schema:**
- `ALTER TABLE messages MODIFY COLUMN role ENUM('user','assistant','system','summary')` (migration `0003_messages_summary_role.sql`). MySQL 8 INSTANT DDL — non-blocking in production. No data migration needed.

**Constructor change:**
- `ConversationService` constructor: 1 → 3 args (`cfg, summarizer, messageLog`). First constructor change since v0.4. Locked by new `conversation.di.test.ts` (the `feedback_sdd_review_layering` net). Whole-branch review caught a related cross-module DI bug (`UsageLogger` not in `SummarizerModule` scope); locked by new full-`AppModule` DI canary in `app-module.di.test.ts`.

**Usage log:**
- One extra row per over-budget event (summarizer's own call). `provider` column carries the actual provider name (`claude-haiku` | `openai-mini`) for cost accounting.

**v0.6 fix wave (post whole-branch review):**
- 1 Critical: `SummarizationService` factory crashed at startup because `UsageLogger` is owned by `HandlersModule` and `SummarizerModule` did not import it. Fixed by exporting `UsageLogger` from `HandlersModule` and adding `imports: [HandlersModule]` to `SummarizerModule`. Regression net: new full-`AppModule` DI canary (`app-module.di.test.ts`) that refuses to mock `UsageLogger`, forcing the real DI graph to resolve it.
- 1 Important: `MessageProcessor` was discarding history to `[]` when `loadOrBuildHistory` threw `SummarizationUnavailableError` (spec required fallback to v0.5 `loadHistory`). Fixed with a 2-tier try/catch: `loadOrBuildHistory` → `loadHistory` → `[]`. 2 new regression tests in `message.processor.test.ts` pin the fail-open contract.

Tests: 185/185 across 40 suites (was 160/35 in v0.5.0; +25 net tests, +5 net suites after T5 refactor + T7 mock rename removed ~13 stale tests). 8 new test suites added across v0.6 covering config getters, summarization service + providers, conversation history building, LLM rendering, and the full-`AppModule` DI canary. `pnpm -r build` green. `pnpm -r lint` green. Whole-branch review verdict: **FIXED — ready to tag**.

## v0.5.0 — 2026-07-12

Per-model conversation-history token budget. v0.4's flat `HISTORY_TOKEN_BUDGET` (default 6000) is replaced by `min(historyTokenBudget, floor(provider.contextWindow × HISTORY_BUDGET_RATIO))`, so long-context models use more of their room by default and short-context models (e.g. Tongyi 8k) are kept honest. v0.4's explicit-cap semantic (`HISTORY_TOKEN_BUDGET` value honored) is preserved — the min wins.

**New env:**
- `HISTORY_BUDGET_RATIO` (default `0.5`, float). Validated `0 ≤ r ≤ 1`. `r = 0` is the "disable per-model" signal (equivalent to v0.4's `historyTokenBudget = 0` via the `min()` precedence). Invalid (`NaN`, `<0`, `>1`) falls back to `0.5` with a one-time warn log per process.

**New APIs:**
- `ConfigService.historyBudgetRatio: number` getter reads the env.
- `LlmHandler.contextWindow: number` getter delegates to the underlying `LlmProvider.contextWindow` (foundation laid in v0.4). For `FallbackProvider`: chain head's window, or `0` if chain is empty (v0.4 precedent).

**New behavior:**
- Effective budget formula: `effective = cfg.historyTokenBudget > 0 ? min(historyTokenBudget, floor(ctxWin * ratio)) : floor(ctxWin * ratio)`. Called once per `MessageProcessor.process()` via the new private helper `computeHistoryBudget()`.
- Backwards-compatible: v0.4 env-only deployments continue to work. Long-context models (Claude 200k, OpenAI 128k) now get `min(6000, 50–100k)` (still capped at 6000). Small-context models (Tongyi 8k) now get `min(6000, 4000) = 4000` — more permissive in headroom than v0.4's flat 6000.

**Refactor:**
- `MessageProcessor.process()` 1-line change: inline `this.config.historyTokenBudget` replaced with `this.computeHistoryBudget()`. Constructor signature unchanged from v0.4 (still 6 args). No DI seam change.

Tests: 160/160 across 35 suites (was 145/33 in v0.4.0; +15 tests, +2 suites: 7 `ConfigService.historyBudgetRatio`, 3 `LlmHandler.contextWindow`, 6 `MessageProcessor.computeHistoryBudget`; -1 v0.4 budget pass-through test replaced by the new helper-wired `budget1`). `pnpm build` green. `pnpm -r lint` green.

## v0.4.0 — 2026-07-12

Token-budget-aware truncation for conversation history. The hard 10-turn cap from v0.2 is replaced by a configurable token budget, so long CJK conversations can keep more context within budget while short ASCII conversations trim aggressively to fit. Token budget is the sole cap; the old 10-turn backstop is removed.

**New APIs:**
- `ConversationService.loadHistory(platform, chatId, senderId, now, options?)` gains optional 5th arg `{ tokenBudget?: number }`. When set, drops oldest whole turns (FIFO) until total estimated tokens ≤ budget. Always keeps the most recent turn. Pass `0` or omit to disable trimming (backwards-compatible with all existing callers).
- New shared utility `estimateTokens(text)` in `@mpcb/shared` — CJK-aware heuristic (CJK / Hiragana / Katakana / Hangul characters = 1 token each; ASCII = `Math.ceil(chars / 4)`).
- `ConfigService.historyTokenBudget` getter reads env var `HISTORY_TOKEN_BUDGET` (default `6000`). `MessageProcessor` reads it and passes to `loadHistory` on every call.
- `LlmProvider` interface gains `readonly contextWindow: number`. Per-provider values: Claude = `200_000`, OpenAI = `128_000`, Tongyi = `8_000`, DeepSeek = `32_000`. `FallbackProvider.contextWindow` = chain head's value (or `0` if chain is empty). The knob ships in a later release — v0.4 lays the foundation only.

**Bug fix (CJK undercounting):**
- `LlmProvider.countTokens` now delegates to the shared `estimateTokens`, replacing the per-provider ASCII-only heuristic that undercounted CJK content. All 5 providers (`Claude`, `OpenAI`, `Tongyi`, `DeepSeek`, `Fallback`) updated.

**Refactor:**
- `MessageProcessor` constructor grows from 5 → 6 args (added `ConfigService`). `WorkerModule.onModuleInit` updated accordingly. 14 call sites audited and verified.
- `HISTORY_LIMIT = 10` removed; token budget supersedes.

**Backwards-compatible:** `loadHistory`'s `options` arg is optional; existing 4-arg callers and tests keep working without modification.

Tests: 145/145 across 33 suites (was 115 in v0.3.1; +30: 8 `estimateTokens`, 5 `ConfigService.historyTokenBudget`, 2 `FallbackProvider.contextWindow`, 12 `ConversationService` budget filter, 2 `MessageProcessor` tokenBudget propagation, 1 MessageProcessor DI-shape canary). `pnpm build` green. `pnpm -r lint` green.

## v0.3.1 — 2026-07-12

Post-review fixes over v0.3.0. The v0.3.0 tag pointed at commits that crashed the worker on startup (NestJS could not DI-resolve `RouterService`'s `source` parameter — same class of bug as v0.2.0's `ConversationService` issue). All consumers should use v0.3.1 instead.

**Critical fix (production-startup blocker):**
- `RouterModule` now uses `useFactory: (store) => new RouterService(store)` with `inject: [RouterConfigStore]` to wire `RouterService`. The bare provider declaration `providers: [RouterService]` could not be resolved because the constructor parameter is a union type (`RouterConfigStore | RouterConfig | { getConfig }`). New DI construction test asserts the service constructs via `Test.createTestingModule(...).compile()` (would have failed against v0.3.0 with `Nest can't resolve dependencies of the RouterService`).

**Important fix (config persistence):**
- `RouterConfigStore.rowsToConfig()` now reads `forget_reply` from the `router_config` MySQL table and maps `{ kind: 'silent' | 'verbose' }` to `cfg.forgetReply`. Previously the value was silently dropped, so admin-set `forget_reply='silent'` had no effect. Deployments wanting silent mode can now achieve it via `UPDATE router_config SET config_value = JSON_OBJECT('kind', 'silent') WHERE config_key = 'forget_reply'`.

Tests: 115/115 across 30 suites (was 112/112 in v0.3.0; +3: 1 RouterModule DI construction, 2 RouterConfigStore forget_reply parsing). `pnpm build` green. `pnpm -r lint` green.

> Note: the v0.3.0 tag remains at the buggy commit `781b11a` for history; DO NOT use it in production. Use `v0.3.1`.

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
