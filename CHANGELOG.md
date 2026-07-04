# Changelog

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
