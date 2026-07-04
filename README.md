# MultiPlatformChatBot (MPCB)

Cross-platform chatbot for WeChat Work, Microsoft Teams, and DingTalk. KB (RAG) + LLM (multi-model fallback) + tool registry, with admin web console.

## Status

v0.1.1 (see CHANGELOG.md). All 30 plan tasks + post-review fixes done. 89/89 tests pass.

## Architecture

pnpm-workspaces monorepo: NestJS backend (`apps/bot-core`) handling webhook intake, BullMQ worker, and admin REST API; Next.js admin console (`apps/admin-web`); shared TypeScript types in `packages/shared`. State in MySQL 8 (11 tables), queue in Redis 7 (BullMQ), KB vectors in Qdrant (1024-dim, cosine). Reverse proxy via `nginx/`.

## Repository layout

- `apps/bot-core/` — NestJS backend (webhook intake, queue worker, handlers, admin API)
- `apps/admin-web/` — Next.js admin console
- `packages/shared/` — shared TypeScript types
- `deploy/` — production Dockerfiles (`Dockerfile.bot`, `Dockerfile.admin`)
- `nginx/` — reverse proxy config
- `docs/superpowers/specs/` — design spec
- `docs/superpowers/plans/` — implementation plan

## Development quickstart

1. Install prerequisites: Node 20 (see `.nvmrc`), pnpm 8, Docker for local MySQL/Redis/Qdrant.
2. Copy env: `cp .env.example .env` and fill in API keys.
3. Start backing services: `docker compose -f docker-compose.dev.yml up -d` (mysql/redis/qdrant).
4. Install deps: `pnpm install`.
5. Build all workspaces: `pnpm build`.
6. Run bot (port 3000): `pnpm --filter @mpcb/bot-core start:dev`.
7. Run admin web (port 3001): `pnpm --filter @mpcb/admin-web dev`.
8. Open `http://localhost:3001` for the admin console.

## Build / Test / Lint

- `pnpm build` — all workspaces
- `pnpm test` — all workspaces (89 tests, mock-based)
- `pnpm -r lint` — strict-mode `tsc --noEmit` per workspace
- `pnpm -r test -- --watch` — watch mode

## Deployment

See [DEPLOY.md](DEPLOY.md) for production deploy with `docker-compose.yml` + nginx.

## Project docs

- Design spec: `docs/superpowers/specs/2026-06-29-multiplatform-chatbot-design.md`
- Implementation plan: `docs/superpowers/plans/2026-06-29-multiplatform-chatbot-mvp.md`
- CHANGELOG: `CHANGELOG.md`

## CI

GitHub Actions at `.github/workflows/ci.yml` runs install → lint (`tsc --noEmit`) → build → test on PRs to `master`.
