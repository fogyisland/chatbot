# MultiPlatformChatBot — Design Spec

**Date:** 2026-06-29
**Status:** Approved (pending spec review)
**Owner:** 徐鹏
**Target Platforms:** WeChat Work (企业微信) / Microsoft Teams / DingTalk (钉钉)

---

## 1. Overview & Goals

Build a unified chatbot that runs on WeChat groups, Teams, and DingTalk groups, providing:

- **Hybrid replies**: knowledge-base lookup, LLM conversation, and tool invocation
- **Command/keyword routing** as the primary navigation model (LLM-classified routing deferred)
- **Production-grade reliability**: queue + retry + dead-letter queue, ready for customer-facing scale
- **Simple operations**: structured logs + health checks + lightweight webhook alerting
- **Admin web console** (Next.js) for ops to manage configuration, view logs, replay failed jobs

### Non-Goals (MVP)

- Cross-platform user identity federation (each platform uses its own user ID)
- Voice / video processing
- LLM-driven agentic orchestration (Router → single handler only in MVP)
- Multi-tenant SaaS (single-tenant only)
- Streaming responses to chat platforms

---

## 2. Architecture Overview

### 2.1 Module Structure (all NestJS modules)

| Module | Responsibility | Public Interface |
|---|---|---|
| `platform-wechat` | WeChat webhook intake, signature verification, message send | `WebhookController`, `MessageSender` |
| `platform-teams` | Teams Bot Framework intake, reply | `WebhookController`, `MessageSender` |
| `platform-dingtalk` | DingTalk Stream API + webhook bot | `WebhookController`, `MessageSender` |
| `router` | Command parsing, keyword matching, handler dispatch | `route(msg): RouteDecision` |
| `handler-kb` | RAG: chunk → embed → retrieve → rerank → LLM | `handle(input, ctx): Reply` |
| `handler-llm` | Multi-provider LLM call with fallback chain | `handle(input, ctx): Reply` |
| `handler-tool` | Tool registry lookup + execution | `handle(input, ctx): Reply` |
| `queue` | BullMQ wrappers, retry policy, DLQ | `enqueue/subscribe` |
| `admin-api` | REST endpoints for admin web (config CRUD, log query, health) | REST API |
| `common` | Shared utilities (logger, config, error types) | — |

### 2.2 Data Flow

```
[WeChat webhook] [Teams webhook] [DingTalk webhook]
        ↓                ↓              ↓
  ┌─────────────────────────────────────────┐
  │ Webhook layer                           │
  │   verifySignature → parseInbound        │
  │   write message log → enqueue          │
  │   → 200 OK immediately                 │
  └─────────────────────────────────────────┘
                  ↓ (BullMQ job)
  ┌─────────────────────────────────────────┐
  │ Worker                                  │
  │   route(msg) → RouteDecision            │
  │   handler.handle(input, ctx)            │
  │   adapter.sendReply(reply, target)      │
  │   write reply log → mark done           │
  └─────────────────────────────────────────┘
                  ↓
        MySQL / Redis / Qdrant
```

### 2.3 Key Architectural Decisions

| Decision | Choice | Reason |
|---|---|---|
| Process model | Single NestJS process (multi-module) | Iterate fast; BullMQ + Redis enable horizontal worker scaling later |
| Queue | BullMQ on Redis | Mature Node.js lib, native retry/DLQ, observable via Bull Board |
| Routing | Command/keyword only in MVP | Deterministic, testable, low cost. LLM classifier deferred |
| Admin stack | Next.js (independent deploy) | Shared TypeScript with NestJS core; clean deployment boundary |
| LLM abstraction | Provider interface, multi-model pluggable | Avoid vendor lock-in; per-route/per-user model selection |
| Vector DB | Qdrant | Open-source, production-ready, Rust performance |
| Vector dimension | 1024 (bge-large-zh-v1.5 default) | Strong Chinese retrieval; swappable per embedder |

---

## 3. Platform Adapter Layer

### 3.1 Normalized Message

```ts
interface NormalizedMessage {
  msgId: string;
  platform: 'wechat' | 'teams' | 'dingtalk';
  chatId: string;
  chatType: 'group' | 'direct';
  senderId: string;
  senderName: string;
  text: string;            // stripped of @mentions and command prefix
  mentions: string[];
  attachments: Attachment[];
  rawTimestamp: number;
}
```

### 3.2 Normalized Reply

```ts
interface NormalizedReply {
  text?: string;
  richText?: RichTextBlock[];
  card?: CardPayload;
  images?: ImageRef[];
  files?: FileRef[];
  replyToMsgId?: string;
}
```

### 3.3 Adapter Interface

```ts
interface PlatformAdapter {
  platform: PlatformName;
  parseInbound(req: RawRequest): Promise<NormalizedMessage>;
  verifySignature(req: RawRequest): boolean;
  sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult>;
  uploadMedia(buffer: Buffer, type: MediaType): Promise<MediaRef>;
}
```

### 3.4 Platform Implementation Notes

| Platform | Protocol | Key Quirks | Adaptation |
|---|---|---|---|
| **WeChat** | Enterprise webhook | 5s timeout, AES encryption, XML passive reply | Acknowledge immediately, send reply via API after async processing |
| **Teams** | Bot Framework v4 | Adaptive Card native, ~15s sync reply window | Sync reply if < 15s; otherwise proactive message via stored reference |
| **DingTalk** | Stream API or webhook bot | Signature + encryption, many message types | Prefer Stream API for cards; fallback to webhook bot |

### 3.5 Supported Message Types (MVP)

All three platforms must support: text, rich text, card, image, file. WeChat "card" is simulated via 图文消息 or Markdown; full Adaptive Card parity not required.

---

## 4. Router

### 4.1 Routing Priority

```
1. Explicit command:    /ask hello    → handler-llm
2. Knowledge prefix:    kb: 报销       → handler-kb
3. Tool prefix:         tool: weather  → handler-tool
4. Default text:        hello          → handler-llm (configurable)
5. Unparseable          → help message
```

### 4.2 Command Syntax

| Form | Example | Behavior |
|---|---|---|
| `/cmd [args]` | `/help`, `/ask 报销` | Literal match, case-insensitive |
| `prefix: content` | `kb: 报销`, `tool: 天气` | Colon-prefixed, prefixes configurable |
| Plain text | `你好` | Default handler (LLM), switchable to command-only mode |
| @bot mention | `@bot 查订单` | Strip mention, then route normally |

### 4.3 Route Decision

```ts
type RouteDecision =
  | { kind: 'command'; handler: 'help' | 'clear' | 'status'; args: string }
  | { kind: 'kb'; query: string; topK?: number }
  | { kind: 'tool'; toolName: string; args: string }
  | { kind: 'llm'; prompt: string; systemPrompt?: string }
  | { kind: 'unknown'; reason: string };
```

### 4.4 Configuration

- **Configurable** (MySQL `router_config`): command list, prefix mappings, default handler
- **Built-in** (hardcoded): `/help`, `/clear`, `/status` (non-disableable)

### 4.5 Route Context

`userId`, `chatId`, `platform`, last 5 messages (short-term memory), user preferences (language, model), rate-limit counters.

---

## 5. Handlers

### 5.1 Unified Handler Interface

```ts
interface Handler<TInput, TOutput> {
  readonly name: string;
  handle(input: TInput, ctx: HandlerContext): Promise<TOutput>;
}

interface HandlerContext {
  userId: string;
  chatId: string;
  platform: PlatformName;
  history: Message[];
  abortSignal: AbortSignal;
}
```

### 5.2 KB Handler (RAG)

**Pipeline:** `query → embed → vector search (topK=10) → rerank (topK=3) → prompt assembly → LLM`

**Sub-modules:**
- `kb-chunker` — 512-token chunks, 64-token overlap, Chinese-aware segmentation
- `kb-embedder` — Text → vector (independent provider from LLM)
- `kb-retriever` — Qdrant client wrapper
- `kb-reranker` — BGE-reranker (optional, skip in MVP if cost-prohibitive)
- `kb-prompt` — Prompt templates with placeholder substitution

**Data:** `kb_documents` (MySQL) holds metadata + raw text; Qdrant holds vectors + payload (chunk_id, doc_id, doc_title, preview).

### 5.3 LLM Handler

```ts
interface LlmProvider {
  name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  streamChat(req: ChatRequest): AsyncIterable<ChatChunk>;
  countTokens(text: string): number;
}
```

**Selection precedence:**
1. Route-level (e.g. `/ask-fast`, `/ask-pro`)
2. User preference
3. Global default
4. Fallback chain (e.g. Claude → Tongyi → error)

**Features:**
- Token counting, persisted to `usage_log`
- Auto-truncation (total < 8K tokens)
- Fallback on transient errors

**MVP constraint:** Synchronous chat only. Streaming is admin-web debugging only; not piped to chat platforms.

### 5.4 Tool Handler

**Built-in tools (MVP):** `weather`, `order` (placeholder), `translate`, `image-gen`.

**Registry schema (`tool_registry` table):**

| Column | Type | Notes |
|---|---|---|
| name | VARCHAR PK | |
| description | TEXT | |
| schema | JSON | Argument validation schema |
| enabled | BOOLEAN | |
| rate_limit | INT | Per-user per-minute |

**Execution safety:** Each tool checks `rate_limit` and `require_permission` before invocation. All calls logged in `tool_invocations`.

### 5.5 Future: Agentic Orchestration

MVP restricts Router → single handler. The `HandlerContext.history` and stable handler interfaces leave room to add a ReAct-style agent loop later without breaking the Router contract.

---

## 6. Async Queue & Reliability

### 6.1 Pipeline

```
Webhook arrival                      Worker consumption
    │                                       │
    ├─ verifySignature                      │
    ├─ parse → NormalizedMessage            │
    ├─ insert message log                   │
    ├─ enqueue message.process { jobId=msgId }
    └─ 200 OK (immediate ack)               │
                                            ├─ dequeue
                                            ├─ router.route(msg)
                                            ├─ handler.handle(input, ctx)
                                            ├─ adapter.sendReply(...)
                                            ├─ write reply log
                                            └─ mark job done
```

**Critical:** Webhook layer only acknowledges + enqueues. Business processing runs out-of-band, eliminating the 5-second WeChat timeout risk.

### 6.2 BullMQ Configuration

- **Queue:** `message.process`
- **Retry policy:** Exponential backoff, 3 attempts (1s, 5s, 25s)
- **Concurrency:** 10 workers (configurable)
- **Job timeout:** 30s (configurable)
- **Priority levels:** `high` (paid users), `default`, `low`

### 6.3 Dead Letter Queue

- **Queue:** `message.dlq`
- **Trigger:** Exhausted retries → auto-enqueue to DLQ
- **Operations:** Admin web lists DLQ entries, allows manual replay
- **Alerting:** DLQ length > 10 → webhook alert

### 6.4 Idempotency

- **Job ID = msgId**, BullMQ/Redis SETNX naturally deduplicates
- **Defense in depth:** Handler checks `(msg_id, platform)` uniqueness before side effects
- **Tool side effects:** `tool_invocations` table dedupes by job_id

### 6.5 Cancellation

- User sends `/stop` → locate active job for `chatId` → `job.discard()`
- 30s hard timeout per handler → AbortController → friendly error reply

### 6.6 Error Classification

| Error Type | Example | Handling |
|---|---|---|
| Platform transient | WeChat rate-limit 5001 | Retry with backoff |
| Platform permanent | Token expired | Immediate DLQ + alert |
| LLM config error | Invalid API key | Fallback to next provider |
| LLM transient | Rate-limited | Retry with backoff |
| Business | KB empty result | Friendly reply, no DLQ |
| Unknown | Unexpected exception | 1 retry, then DLQ |

---

## 7. Data Model & Storage

### 7.1 MySQL Schema

| Table | Purpose | Key Columns |
|---|---|---|
| `users` | User profile | id, platform, platform_user_id, display_name, language, role |
| `chats` | Chat metadata | id, platform, chat_id, chat_type, name |
| `messages` | Message log | id, msg_id (UNIQUE), platform, chat_id, sender_id, role, content, created_at |
| `conversations` | Conversation snapshot | id, user_id, chat_id, summary, last_active_at |
| `kb_documents` | KB raw docs | id, title, source_uri, version, status, chunk_count |
| `kb_chunks` | KB chunks | id, doc_id, chunk_index, content, token_count |
| `tool_invocations` | Tool call log | id, job_id, tool_name, args, result, status |
| `router_config` | Router config | key, value, enabled |
| `tool_registry` | Tool registry | name, description, schema, enabled, rate_limit |
| `usage_log` | LLM usage | user_id, provider, model, prompt_tokens, completion_tokens, cost |
| `dlq_records` | DLQ records | job_id, payload, error, retries, created_at |

**Key indexes:**
- `messages (platform, chat_id, created_at)` — conversation history lookup
- `messages (msg_id, platform)` UNIQUE — idempotency
- `kb_chunks (doc_id, chunk_index)` UNIQUE — document rebuild integrity

### 7.2 Redis Usage

| Key pattern | Purpose | TTL |
|---|---|---|
| `bull:message.process:*` | BullMQ queue | job lifetime |
| `rate:user:{userId}:{minute}` | Per-user rate limit | 90s |
| `cache:user:{userId}` | User profile cache | 5min |
| `cache:config:router` | Router config cache | 60s |
| `lock:doc:{docId}` | Doc rebuild lock | processing |
| `active_job:{chatId}` | Active job for /stop | processing |

### 7.3 Qdrant

- **Collection:** `kb_chunks`
- **Vector dimension:** 1024 (bge-large-zh-v1.5 default)
- **Distance:** Cosine
- **Payload:** `chunk_id, doc_id, doc_title, chunk_index, content_preview, tenant_id?`
- **Index:** HNSW

### 7.4 Data Retention

| Data Type | Retention | Cleanup |
|---|---|---|
| Message log | 90 days | Scheduled job |
| LLM usage | 365 days | Monthly partition rotation |
| DLQ records | 30 days | Delete after manual review or expiry |
| Conversation snapshot | Permanent | Per business need |
| KB content | Permanent | Soft delete + version control |

### 7.5 KB Versioning

Every doc rebuild creates a new `version`; old chunks get `superseded_at = NOW()`.
- Current version: `superseded_at IS NULL`
- Retrieval filters on current version only
- Rollback = clear `superseded_at` on previous version

---

## 8. Error Handling & Observability

### 8.1 Structured Logging

**Library:** `pino` (fastest Node.js JSON logger)
**Output:** stdout + daily rolling file (100MB × 30 days) + separate error file
**Format:** JSON with `ts, level, service, traceId, msgId, chatId, userId, platform, route, handler, durationMs, tokens, msg`

**Sampling:**
- `error`, `warn`: full
- `info`: full (key events only)
- `debug`: dev only
- `trace`: **disabled** (LLM prompt/response never logged — privacy + cost)

### 8.2 Trace Correlation

`traceId = msgId` set on webhook intake, propagated through all subsequent logs. Failure investigation = `grep traceId logs.json`.

### 8.3 Health Endpoints

| Endpoint | Purpose | Checks |
|---|---|---|
| `GET /health` | Liveness | Process responsive |
| `GET /ready` | Readiness | MySQL/Redis/Qdrant + BullMQ worker count |
| `GET /metrics` | Prometheus | Queue depth, P50/P95 latency, error rate |
| `GET /admin/dlq/stats` | DLQ summary | DLQ length, last 10 entries |

### 8.4 Alerting (lightweight, no Prometheus+Grafana in MVP)

Webhook alerts to DingTalk/Lark group on:
- `/ready` returns non-200
- DLQ length > 10
- Processing P95 > 30s
- 5-min scheduled probe failure

Config: `alert.config.yaml` — thresholds + receiver webhooks.

### 8.5 Runbook

| Symptom | Diagnose | Recover |
|---|---|---|
| Webhooks silent | `/health`, platform callback config | Restart + re-register callback |
| DLQ piling up | Admin DLQ view | Fix root cause, manual replay |
| All LLM failing | Provider config + API key | Switch to fallback provider |
| KB empty | `kb_documents.status` | Re-trigger rebuild |
| Queue blocked | Bull Board | Scale worker concurrency |

---

## 9. Admin Web Console

Next.js (TypeScript), independent deployment, shares types with NestJS core via shared package.

**Pages (MVP):**
- **Dashboard** — real-time queue depth, active workers, error rate (last 1h)
- **Message search** — by time/platform/user
- **DLQ view** — list + one-click replay
- **Router config** — CRUD for commands/prefixes
- **Tool registry** — enable/disable, edit rate limits
- **KB management** — upload docs, view rebuild status
- **User management** — view users, set per-user model preferences
- **Health/logs** — view structured logs filtered by traceId

**Auth:** token-based, IP whitelist for MVP.

---

## 10. Testing Strategy

### 10.1 Pyramid

| Level | Tool | Coverage Targets |
|---|---|---|
| Unit | Jest | Router decisions, prompt templates, token calc, config parsing |
| Integration | Jest + Testcontainers | Handlers + Queue + real MySQL/Redis/Qdrant |
| Platform adapter | Jest + custom mocks | parseInbound/verifySignature/sendReply for each platform |
| E2E | supertest + docker-compose | Full webhook → handler → reply with mocked platforms |

### 10.2 Mocking Principles

- Three PlatformAdapter implementations → each gets a mock harness verifying the main flow is platform-agnostic
- LLM providers → mocked, fixed responses (avoid real API cost)
- External APIs (weather, orders) → WireMock or stub server

### 10.3 MVP Critical Test Cases

- Three platform webhook signature verification (WeChat AES, Teams JWT, DingTalk signing)
- Router correctly routes each command form
- Message idempotency (same msgId enqueued twice → processed once)
- DLQ behavior (exceeded retries → auto-DLQ)
- LLM provider fallback (primary fails → secondary succeeds)
- KB retrieval recall (test set → top-3 hit rate)
- Tool rate-limit triggers rejection
- Admin API auth (token validation)
- Health endpoints return 503 when dependencies are down

---

## 11. Deployment

### 11.1 Topology

```
Cloud server (4-core 8GB recommended)
├── Docker Compose
│   ├── app (NestJS, :3000)
│   ├── admin-web (Next.js, :3001)
│   ├── mysql 8.x (:3306)
│   ├── redis 7.x (:6379)
│   └── qdrant latest (:6333)
└── Nginx reverse proxy (:80/:443)
    ├── /bot/* → app:3000
    └── /admin/* → admin-web:3001 (IP whitelist)
```

**Webhook URLs (example):**
- WeChat: `https://bot.example.com/bot/wechat/callback`
- Teams: `https://bot.example.com/bot/teams/messages`
- DingTalk: `https://bot.example.com/bot/dingtalk/stream`

### 11.2 CI/CD

- **GitHub Actions:**
  - PR → lint + typecheck + unit tests
  - main merge → integration tests + Docker build + push to registry
- **Deploy:** `docker compose pull && docker compose up -d`
- **Config separation:** `.env.production` via docker secrets, never in git

### 11.3 Go-Live Checklist

- [ ] All three platform webhook URLs registered
- [ ] HTTPS cert + DNS configured
- [ ] LLM provider API keys validated
- [ ] Initial KB documents imported + retrieval verified
- [ ] Admin web auth configured
- [ ] All health endpoints return 200
- [ ] Alert webhook tested (simulated failure → alert received)
- [ ] DLQ replay procedure rehearsed
- [ ] MySQL daily backup to OSS configured

### 11.4 Scale-Out Path

| Stage | QPS | Architecture |
|---|---|---|
| 1 | < 50 | Current single-instance |
| 2 | 50–500 | BullMQ workers scaled horizontally (same Redis, multiple app instances) |
| 3 | > 500 | Split microservices (Adapter Gateway / Handler Workers), introduce Kafka |

---

## 12. Feasibility & Risk Assessment

### Conclusion: **Feasible, recommended**

**Reasoning:**
1. All three platform SDKs/APIs are mature and well-documented
2. NestJS + BullMQ + MySQL + Redis + Qdrant is a production-validated stack
3. Routing → RAG → LLM → Tool patterns have abundant reference implementations
4. MVP scope is bounded; horizontal scale path is clean

### Key Risks

| Risk | Impact | Mitigation |
|---|---|---|
| WeChat 5s timeout | Perceived latency | Webhook ack + async processing (designed in) |
| LLM cost overrun | Bill shock | `usage_log` monitoring + per-user rate limits + command routing reduces LLM calls |
| Platform policy change | API breakage | Adapter isolation + abstraction layer |
| RAG retrieval quality | Wrong answers | Chunk quality + reranker + eval set |
| Domestic LLM compliance | Cross-border data | Default to domestic providers; cross-border via config |

### MVP Time Estimate (single developer)

- Project skeleton + 3 adapters: 2–3 weeks
- Router + 3 handlers: 2–3 weeks
- Queue + DLQ + rate limit: 1 week
- KB upload + RAG: 1–2 weeks
- Admin web basics: 2 weeks
- Testing + go-live: 1–2 weeks
- **Total MVP: 8–12 weeks**

---

## 13. Out of Scope (Future)

- LLM-driven agentic orchestration (ReAct / multi-step planning)
- Streaming responses to chat platforms
- Voice / video processing
- Multi-tenant SaaS
- Cross-platform user identity federation
- A/B testing framework for prompts
- Fine-tuned domain models
- Sentiment analysis / user satisfaction scoring

---

*End of spec*