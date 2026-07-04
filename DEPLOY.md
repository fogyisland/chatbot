# Production Deployment

## Prerequisites

- Linux server (Ubuntu 22.04 / Alibaba Cloud Linux 3) with Docker 24+ and Docker Compose v2
- A registered domain pointing to the server's public IP (for webhook callbacks)
- TLS certificates (Let's Encrypt or cloud provider) — place in `nginx/certs/`
- Outbound HTTPS to LLM provider APIs and the embedding service

## Pre-flight

1. Clone the repo on the server: `git clone <repo-url> mpcb && cd mpcb`
2. Checkout the release tag: `git checkout v0.1.1`
3. Copy and edit `.env.production.example` → `.env.production`:
   - Set `ADMIN_API_TOKEN` to a strong random value: `openssl rand -hex 32`
   - Set `MYSQL_PASSWORD` to a strong value
   - Set all LLM API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY`)
   - Set platform credentials (`WECHAT_CORP_ID`/`WECHAT_CORP_SECRET`/`WECHAT_TOKEN`, `TEAMS_APP_ID`/`TEAMS_APP_SECRET`, `DINGTALK_APP_KEY`/`DINGTALK_APP_SECRET`)
   - Set `EMBEDDING_API_KEY`
4. Place TLS cert + key in `nginx/certs/`:
   - `nginx/certs/fullchain.pem`
   - `nginx/certs/privkey.pem`

## Apply database migrations

The MySQL container auto-applies `apps/bot-core/migrations/0001_init.sql` on first boot via the docker-entrypoint init scripts. Verify by:

```bash
docker compose --env-file .env.production exec mysql mysql -umpcb -p$MYSQL_PASSWORD mpcb -e 'SHOW TABLES;'
```

Expect 11 tables: `users`, `chats`, `messages`, `conversations`, `kb_documents`, `kb_chunks`, `tool_registry`, `tool_invocations`, `router_config`, `usage_log`, `dlq_records`.

## Start the stack

```bash
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
```

Expect: `bot`, `admin`, `nginx`, `mysql` (healthy), `redis` (healthy), `qdrant` (healthy).

## Configure platform webhooks

Set each platform's webhook URL to point at your domain:

- WeChat Work: `https://<your-domain>/bot/wechat/callback` with token matching `WECHAT_TOKEN`
- Microsoft Teams: `https://<your-domain>/bot/teams/messages` with the Bot Framework messaging endpoint
- DingTalk: `https://<your-domain>/bot/dingtalk/callback` via the Stream API app settings

## Verify health

```bash
curl -fsS https://<your-domain>/health
curl -fsS https://<your-domain>/ready
curl -fsS -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<your-domain>/admin/usage
```

## Enable HTTPS (nginx)

The provided `nginx/nginx.conf` only listens on port 80. To enable TLS:

1. Add a `listen 443 ssl http2;` block inside the server section
2. Add `ssl_certificate /etc/nginx/certs/fullchain.pem;` and `ssl_certificate_key /etc/nginx/certs/privkey.pem;`
3. Add an HTTP→HTTPS redirect on port 80
4. `docker compose --env-file .env.production restart nginx`

TLS configuration is intentionally not bundled in v0.1.1 — see CHANGELOG.md "outstanding Minor items".

## Upgrading

```bash
git fetch --tags
git checkout <new-tag>
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d
```

## Common operations

- View bot logs: `docker compose --env-file .env.production logs -f bot`
- Tail worker activity only: `docker compose --env-file .env.production logs -f bot | grep -E 'Worker|MessageProcessor'`
- List DLQ records: `curl -fsS -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<your-domain>/admin/dlq`
- Replay a DLQ job: `curl -fsS -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<your-domain>/admin/dlq/<job-id>/replay`
- Inspect recent messages: `docker compose --env-file .env.production exec mysql mysql -umpcb -p$MYSQL_PASSWORD mpcb -e 'SELECT platform, chat_id, role, LEFT(content,80) FROM messages ORDER BY created_at DESC LIMIT 20;'`
- Inspect router config: `docker compose --env-file .env.production exec mysql mysql -umpcb -p$MYSQL_PASSWORD mpcb -e 'SELECT * FROM router_config;'`
- Restart bot only: `docker compose --env-file .env.production restart bot`

## Backup

- MySQL: `docker compose --env-file .env.production exec mysql mysqldump -umpcb -p$MYSQL_PASSWORD mpcb > backup-$(date +%F).sql`
- Qdrant: snapshot API at `http://<your-domain>:6333/snapshots` (or via the `qdrant_data` volume)

## Troubleshooting

- Bot returns 401 on send → check `WECHAT_TOKEN` / Teams / DingTalk credentials in `.env.production`
- DLQ growing → inspect worker logs (`docker compose logs bot | grep -i 'failed'`) and the `messages` table for the failing chat
- LLM 4xx/5xx → check `usage_log` for the failing provider and model; verify API keys
- KB answers are empty → verify Qdrant collection `kb_chunks` has data: `curl http://<qdrant>:6333/collections/kb_chunks`
