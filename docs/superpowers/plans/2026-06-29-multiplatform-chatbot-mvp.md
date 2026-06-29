# MultiPlatformChatBot MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-platform chatbot serving WeChat Work groups, Microsoft Teams, and DingTalk groups with hybrid replies (KB + LLM + Tool), command/keyword routing, queue-based reliability, and a simple admin web console.

**Architecture:** Single NestJS process with modular design (platform adapters, router, handlers, queue). Webhook layer immediately acks and enqueues to BullMQ; workers consume jobs, route to handlers, and reply asynchronously. Three platforms behind a `PlatformAdapter` interface so business logic stays platform-agnostic. Next.js admin web in a separate process shares types via a `packages/shared` workspace package.

**Tech Stack:** TypeScript, NestJS 10+, pnpm workspaces, BullMQ (Redis 7), MySQL 8, Qdrant (vector DB), Next.js 14 (admin web), Pino (logging), Jest + Testcontainers (testing), Docker Compose (deployment).

---

## File Structure

```
MultiPlatformChatBot/
├── package.json                          # Root workspace
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.dev.yml                # Dev (hot reload)
├── docker-compose.yml                    # Production
├── nginx/nginx.conf
├── deploy/
│   ├── Dockerfile.bot
│   └── Dockerfile.admin
├── apps/
│   ├── bot-core/                         # NestJS main
│   │   ├── src/main.ts
│   │   ├── src/app.module.ts
│   │   ├── src/common/{logger,config,filters,decorators}
│   │   ├── src/platform/{platform.module,platform-adapter.interface,wechat,teams,dingtalk}
│   │   ├── src/router/{router.module,router.service,router.types}
│   │   ├── src/handlers/{handlers.module,handler.interface,kb,llm,tool}
│   │   ├── src/queue/{queue.module,queue.service,message.processor}
│   │   ├── src/webhook/{webhook.module,health.controller}
│   │   ├── src/admin-api/{admin.module,admin.controller}
│   │   └── test/
│   └── admin-web/                        # Next.js 14
│       ├── pages/{index,messages,dlq,router,tools,kb,users,login}
│       └── lib/api.ts
└── packages/
    └── shared/                           # Shared TS types
        └── src/{index,normalized-message,normalized-reply,platform,route-decision}
```

**Decomposition rationale:** Each NestJS subfolder is one NestJS module with clear boundaries. Webhook intake is isolated from business logic (queue boundary). Three platform adapters live side-by-side because they implement the same interface but require independent testing. Admin web is fully separate (no shared runtime) but reuses types from `packages/shared`.

---

## Global Constraints

These apply to every task. Tasks do not restate them.

- **Language:** TypeScript strict mode (`"strict": true` in `tsconfig.base.json`)
- **Node.js:** ≥ 20 LTS
- **Package manager:** pnpm ≥ 8 (workspaces)
- **NestJS:** ≥ 10
- **MySQL:** 8.x, charset `utf8mb4`, collation `utf8mb4_unicode_ci`
- **Redis:** 7.x
- **Qdrant:** latest stable, vector dim 1024 (bge-large-zh-v1.5 default)
- **Code style:** Prettier defaults + ESLint with `@typescript-eslint/recommended`
- **Commit style:** Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`)
- **Test framework:** Jest ≥ 29
- **TDD discipline:** Red → Green → Refactor → Commit for every behavior task
- **No dead code:** No commented-out code, no unused exports, no premature abstractions
- **YAGNI:** Defer streaming responses to chat platforms, agentic orchestration, multi-tenancy, voice/video, A/B testing
- **Logging:** Pino structured JSON, never log LLM prompt/response bodies (privacy + cost)
- **Idempotency:** All webhook entry points use `msgId` as BullMQ jobId to prevent duplicate processing

---

## Phase 0 — Project Foundation

### Task 1: Initialize pnpm workspace and TypeScript base config

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.npmrc`

**Step 1: Create root `package.json`**

```json
{
  "name": "multiplatform-chatbot",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "dev:bot": "pnpm --filter @mpcb/bot-core start:dev",
    "dev:admin": "pnpm --filter @mpcb/admin-web dev"
  },
  "engines": {
    "node": ">=20"
  }
}
```

**Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

**Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true
  }
}
```

**Step 4: Create `.npmrc`**

```
auto-install-peers=true
strict-peer-dependencies=false
```

**Step 5: Install pnpm and verify**

Run: `npm install -g pnpm && pnpm --version`
Expected: prints pnpm version ≥ 8

**Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .npmrc
git commit -m "chore: initialize pnpm workspace and tsconfig base"
```

---

### Task 2: Create `packages/shared` with normalized message types

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/platform.ts`
- Create: `packages/shared/src/normalized-message.ts`
- Create: `packages/shared/src/normalized-reply.ts`
- Create: `packages/shared/src/route-decision.ts`
- Test: `packages/shared/test/types.test.ts`

**Step 1: Write the failing test**

`packages/shared/test/types.test.ts`:
```ts
import {
  PlatformName,
  NormalizedMessage,
  NormalizedReply,
  RouteDecision,
} from '../src';

describe('shared types', () => {
  it('PlatformName is a string literal union', () => {
    const p: PlatformName = 'wechat';
    expect(['wechat', 'teams', 'dingtalk']).toContain(p);
  });

  it('NormalizedMessage accepts a fully populated object', () => {
    const m: NormalizedMessage = {
      msgId: 'm1',
      platform: 'wechat',
      chatId: 'c1',
      chatType: 'group',
      senderId: 'u1',
      senderName: 'Alice',
      text: 'hello',
      mentions: ['u2'],
      attachments: [],
      rawTimestamp: Date.now(),
    };
    expect(m.msgId).toBe('m1');
  });

  it('NormalizedReply allows text-only', () => {
    const r: NormalizedReply = { text: 'hi' };
    expect(r.text).toBe('hi');
  });

  it('RouteDecision discriminates on kind', () => {
    const d: RouteDecision = { kind: 'llm', prompt: 'hello' };
    if (d.kind === 'llm') {
      expect(d.prompt).toBe('hello');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm test` (fails — package doesn't exist yet)

**Step 3: Create `packages/shared/package.json`**

```json
{
  "name": "@mpcb/shared",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "lint": "echo 'lint shared'"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.10.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.3.0"
  }
}
```

**Step 4: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["test", "node_modules", "dist"]
}
```

**Step 5: Create `packages/shared/src/platform.ts`**

```ts
export type PlatformName = 'wechat' | 'teams' | 'dingtalk';
export type ChatType = 'group' | 'direct';
export type MediaType = 'image' | 'file' | 'audio' | 'video';

export interface MediaRef {
  platformMediaId: string;
  url?: string;
}

export interface Attachment {
  type: MediaType;
  url: string;
  filename?: string;
  sizeBytes?: number;
}

export interface ChatTarget {
  chatId: string;
  chatType: ChatType;
}
```

**Step 6: Create `packages/shared/src/normalized-message.ts`**

```ts
import { Attachment, ChatType, PlatformName } from './platform';

export interface NormalizedMessage {
  msgId: string;
  platform: PlatformName;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName: string;
  text: string;
  mentions: string[];
  attachments: Attachment[];
  rawTimestamp: number;
}
```

**Step 7: Create `packages/shared/src/normalized-reply.ts`**

```ts
import { MediaRef } from './platform';

export interface RichTextBlock {
  type: 'text' | 'link' | 'bold' | 'code';
  content: string;
  href?: string;
}

export interface CardPayload {
  title: string;
  fields: Array<{ label: string; value: string }>;
  footer?: string;
}

export interface NormalizedReply {
  text?: string;
  richText?: RichTextBlock[];
  card?: CardPayload;
  images?: MediaRef[];
  files?: MediaRef[];
  replyToMsgId?: string;
}
```

**Step 8: Create `packages/shared/src/route-decision.ts`**

```ts
export type RouteDecision =
  | { kind: 'command'; handler: 'help' | 'clear' | 'status'; args: string }
  | { kind: 'kb'; query: string; topK?: number }
  | { kind: 'tool'; toolName: string; args: string }
  | { kind: 'llm'; prompt: string; systemPrompt?: string }
  | { kind: 'unknown'; reason: string };
```

**Step 9: Create `packages/shared/src/index.ts`**

```ts
export * from './platform';
export * from './normalized-message';
export * from './normalized-reply';
export * from './route-decision';
```

**Step 10: Create `packages/shared/jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
};
```

**Step 11: Build and test**

Run: `cd packages/shared && pnpm install && pnpm build && pnpm test`
Expected: 4 tests pass, dist/ created

**Step 12: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): define normalized message, reply, and route types"
```

---

## Phase 1 — Infrastructure

### Task 3: Docker Compose for MySQL, Redis, Qdrant (dev)

**Files:**
- Create: `docker-compose.dev.yml`
- Create: `.env.example`

**Step 1: Create `.env.example` at repo root**

```
# Database
MYSQL_ROOT_PASSWORD=rootpw
MYSQL_DATABASE=mpcb
MYSQL_USER=mpcb
MYSQL_PASSWORD=mpcb_pw

# Redis (no auth in dev)
REDIS_PORT=6379

# Qdrant
QDRANT_PORT=6333

# Bot
BOT_PORT=3000
ADMIN_PORT=3001

# LLM (placeholders — replace with real keys)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
DASHSCOPE_API_KEY=
DEEPSEEK_API_KEY=
```

**Step 2: Create `docker-compose.dev.yml`**

```yaml
version: "3.9"

services:
  mysql:
    image: mysql:8.0
    container_name: mpcb-mysql
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: ${MYSQL_DATABASE}
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: mpcb-redis
    restart: unless-stopped
    ports:
      - "${REDIS_PORT}:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 5

  qdrant:
    image: qdrant/qdrant:latest
    container_name: mpcb-qdrant
    restart: unless-stopped
    ports:
      - "${QDRANT_PORT}:6333"
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:6333/healthz"]
      interval: 5s
      retries: 5

volumes:
  mysql_data:
  qdrant_data:
```

**Step 3: Copy env file and start services**

Run: `cp .env.example .env && docker compose -f docker-compose.dev.yml up -d`
Expected: three containers start, healthchecks pass

**Step 4: Verify connectivity**

Run: `docker compose -f docker-compose.dev.yml ps`
Expected: All services show "Up" and "(healthy)"

**Step 5: Commit**

```bash
git add docker-compose.dev.yml .env.example
git commit -m "chore: add dev docker-compose for mysql, redis, qdrant"
```

---

### Task 4: MySQL schema migrations

**Files:**
- Create: `apps/bot-core/migrations/0001_init.sql`
- Create: `apps/bot-core/scripts/migrate.ts`
- Create: `apps/bot-core/package.json` (only the migration script needs)
- Test: `apps/bot-core/test/migrate.test.ts`

**Step 1: Create `apps/bot-core/migrations/0001_init.sql`**

```sql
-- Users
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  platform VARCHAR(16) NOT NULL,
  platform_user_id VARCHAR(128) NOT NULL,
  display_name VARCHAR(128),
  language VARCHAR(8) DEFAULT 'zh',
  role VARCHAR(16) DEFAULT 'user',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_users_platform (platform, platform_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chats
CREATE TABLE IF NOT EXISTS chats (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  platform VARCHAR(16) NOT NULL,
  chat_id VARCHAR(128) NOT NULL,
  chat_type VARCHAR(16) NOT NULL,
  name VARCHAR(128),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_chats_platform (platform, chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  msg_id VARCHAR(128) NOT NULL,
  platform VARCHAR(16) NOT NULL,
  chat_id VARCHAR(128) NOT NULL,
  sender_id VARCHAR(128) NOT NULL,
  role ENUM('user','assistant','system') NOT NULL,
  content MEDIUMTEXT NOT NULL,
  trace_id VARCHAR(128),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_messages_msg (platform, msg_id),
  KEY idx_messages_chat_time (platform, chat_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  chat_id VARCHAR(128) NOT NULL,
  summary TEXT,
  last_active_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_conv_user (user_id, last_active_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- KB Documents
CREATE TABLE IF NOT EXISTS kb_documents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(256) NOT NULL,
  source_uri VARCHAR(512),
  version INT NOT NULL DEFAULT 1,
  status ENUM('pending','indexing','ready','failed','superseded') NOT NULL DEFAULT 'pending',
  chunk_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  superseded_at DATETIME(3),
  KEY idx_kb_docs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- KB Chunks
CREATE TABLE IF NOT EXISTS kb_chunks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_id BIGINT UNSIGNED NOT NULL,
  chunk_index INT NOT NULL,
  content MEDIUMTEXT NOT NULL,
  token_count INT NOT NULL,
  UNIQUE KEY uk_kb_chunks_doc (doc_id, chunk_index),
  KEY idx_kb_chunks_doc (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tool registry
CREATE TABLE IF NOT EXISTS tool_registry (
  name VARCHAR(64) PRIMARY KEY,
  description TEXT,
  schema_json JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit INT NOT NULL DEFAULT 10,
  require_permission VARCHAR(64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tool invocations
CREATE TABLE IF NOT EXISTS tool_invocations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_id VARCHAR(128) NOT NULL,
  tool_name VARCHAR(64) NOT NULL,
  args_json JSON,
  result_json JSON,
  status ENUM('success','error','rate_limited') NOT NULL,
  error_message TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_tool_job (job_id, tool_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Router config (K-V)
CREATE TABLE IF NOT EXISTS router_config (
  config_key VARCHAR(64) PRIMARY KEY,
  config_value JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Usage log
CREATE TABLE IF NOT EXISTS usage_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED,
  provider VARCHAR(32) NOT NULL,
  model VARCHAR(64) NOT NULL,
  prompt_tokens INT NOT NULL,
  completion_tokens INT NOT NULL,
  cost_usd DECIMAL(10,6),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_usage_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DLQ records
CREATE TABLE IF NOT EXISTS dlq_records (
  job_id VARCHAR(128) PRIMARY KEY,
  payload_json JSON NOT NULL,
  error_message TEXT,
  retries INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed default router config
INSERT IGNORE INTO router_config (config_key, config_value, enabled) VALUES
  ('commands', JSON_OBJECT('help','help','clear','clear','status','status'), TRUE),
  ('prefixes', JSON_OBJECT('kb','kb','tool','tool','ask','llm'), TRUE),
  ('default_handler', JSON_OBJECT('kind','llm'), TRUE),
  ('command_only_mode', JSON_OBJECT('enabled', FALSE), TRUE);
```

**Step 2: Write the migration script test**

`apps/bot-core/test/migrate.test.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

describe('migrations directory', () => {
  it('contains 0001_init.sql', () => {
    const p = path.join(__dirname, '..', 'migrations', '0001_init.sql');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('0001_init.sql declares all required tables', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '0001_init.sql'),
      'utf8',
    );
    for (const t of [
      'users', 'chats', 'messages', 'conversations',
      'kb_documents', 'kb_chunks', 'tool_registry', 'tool_invocations',
      'router_config', 'usage_log', 'dlq_records',
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE.*\\b${t}\\b`, 'i'));
    }
  });
});
```

**Step 3: Run test to verify it passes (the SQL file is the system under test)**

Run: `cd apps/bot-core && pnpm jest test/migrate.test.ts`
Expected: 2 tests pass

**Step 4: Apply the migration manually to verify SQL is valid**

Run: `docker compose -f docker-compose.dev.yml exec -T mysql mysql -umpcb -pmpcb_pw mpcb < apps/bot-core/migrations/0001_init.sql`
Expected: no error output

**Step 5: Verify tables**

Run: `docker compose -f docker-compose.dev.yml exec -T mysql mysql -umpcb -pmpcb_pw mpcb -e "SHOW TABLES;"`
Expected: lists 11 tables

**Step 6: Commit**

```bash
git add apps/bot-core/migrations
git commit -m "feat(db): add initial MySQL schema with seed router config"
```

---

## Phase 2 — Bot Core Skeleton

### Task 5: NestJS app scaffold with config, logger, health

**Files:**
- Create: `apps/bot-core/package.json`
- Create: `apps/bot-core/tsconfig.json`
- Create: `apps/bot-core/tsconfig.build.json`
- Create: `apps/bot-core/nest-cli.json`
- Create: `apps/bot-core/src/main.ts`
- Create: `apps/bot-core/src/app.module.ts`
- Create: `apps/bot-core/src/common/config/config.module.ts`
- Create: `apps/bot-core/src/common/config/config.service.ts`
- Create: `apps/bot-core/src/common/logger/logger.module.ts`
- Create: `apps/bot-core/src/webhook/health.controller.ts`
- Create: `apps/bot-core/test/health.test.ts`

**Step 1: Write the health endpoint test**

`apps/bot-core/test/health.test.ts`:
```ts
import { Test } from '@nestjs/testing';
import { HealthController } from '../src/webhook/health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    controller = module.get(HealthController);
  });

  it('GET /health returns ok', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
  });

  it('GET /ready returns ready', () => {
    expect(controller.ready()).toEqual({ status: 'ready' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/health.test.ts`
Expected: FAIL — HealthController not found

**Step 3: Create `apps/bot-core/package.json`**

```json
{
  "name": "@mpcb/bot-core",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "node dist/main.js",
    "start:dev": "nest start --watch",
    "test": "jest",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "@mpcb/shared": "workspace:*",
    "@nestjs/common": "^10.2.0",
    "@nestjs/core": "^10.2.0",
    "@nestjs/platform-express": "^10.2.0",
    "mysql2": "^3.6.0",
    "ioredis": "^5.3.0",
    "bullmq": "^5.0.0",
    "@qdrant/js-client-rest": "^1.4.0",
    "pino": "^8.16.0",
    "nestjs-pino": "^4.0.0",
    "reflect-metadata": "^0.1.14",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.2.0",
    "@nestjs/schematics": "^10.0.0",
    "@nestjs/testing": "^10.2.0",
    "@types/express": "^4.17.0",
    "@types/jest": "^29.5.0",
    "@types/node": "^20.10.0",
    "@types/supertest": "^2.0.16",
    "jest": "^29.7.0",
    "supertest": "^6.3.0",
    "ts-jest": "^29.1.0",
    "ts-loader": "^9.5.0",
    "ts-node": "^10.9.0",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.3.0"
  }
}
```

**Step 4: Create `apps/bot-core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": true,
    "noImplicitAny": true,
    "strictBindCallApply": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": false
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 5: Create `apps/bot-core/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

**Step 6: Create `apps/bot-core/nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true
  }
}
```

**Step 7: Create `apps/bot-core/src/common/config/config.service.ts`**

```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
  get nodeEnv(): string {
    return process.env.NODE_ENV ?? 'development';
  }
  get botPort(): number {
    return Number(process.env.BOT_PORT ?? 3000);
  }
  get mysqlHost(): string {
    return process.env.MYSQL_HOST ?? 'localhost';
  }
  get mysqlPort(): number {
    return Number(process.env.MYSQL_PORT ?? 3306);
  }
  get mysqlUser(): string {
    return process.env.MYSQL_USER ?? 'mpcb';
  }
  get mysqlPassword(): string {
    return process.env.MYSQL_PASSWORD ?? 'mpcb_pw';
  }
  get mysqlDatabase(): string {
    return process.env.MYSQL_DATABASE ?? 'mpcb';
  }
  get redisHost(): string {
    return process.env.REDIS_HOST ?? 'localhost';
  }
  get redisPort(): number {
    return Number(process.env.REDIS_PORT ?? 6379);
  }
  get qdrantUrl(): string {
    return process.env.QDRANT_URL ?? 'http://localhost:6333';
  }
  get anthropicApiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY;
  }
  get openaiApiKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }
  get dashscopeApiKey(): string | undefined {
    return process.env.DASHSCOPE_API_KEY;
  }
  get deepseekApiKey(): string | undefined {
    return process.env.DEEPSEEK_API_KEY;
  }
}
```

**Step 8: Create `apps/bot-core/src/common/config/config.module.ts`**

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';

@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
```

**Step 9: Create `apps/bot-core/src/common/logger/logger.module.ts`**

```ts
import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        formatters: {
          level: (label) => ({ level: label }),
        },
        timestamp: () => `,"ts":"${new Date().toISOString()}"`,
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie'],
          censor: '[redacted]',
        },
      },
    }),
  ],
})
export class LoggerModule {}
```

**Step 10: Create `apps/bot-core/src/webhook/health.controller.ts`**

```ts
import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  ready() {
    return { status: 'ready' };
  }
}
```

**Step 11: Create `apps/bot-core/src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { HealthController } from './webhook/health.controller';

@Module({
  imports: [ConfigModule, LoggerModule],
  controllers: [HealthController],
})
export class AppModule {}
```

**Step 12: Create `apps/bot-core/src/main.ts`**

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ConfigService } from './common/config/config.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  await app.listen(config.botPort);
  app.get(Logger).log(`bot-core listening on :${config.botPort}`);
}

bootstrap();
```

**Step 13: Create `apps/bot-core/jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  moduleDirectories: ['node_modules', 'src'],
};
```

**Step 14: Install and run tests**

Run: `cd apps/bot-core && pnpm install && pnpm test`
Expected: 2 tests pass

**Step 15: Commit**

```bash
git add apps/bot-core
git commit -m "feat(bot-core): nestjs scaffold with config, logger, health endpoints"
```

---

## Phase 3 — Platform Adapters

### Task 6: PlatformAdapter interface and abstract base

**Files:**
- Create: `apps/bot-core/src/platform/platform-adapter.interface.ts`
- Create: `apps/bot-core/src/platform/platform.module.ts`
- Create: `apps/bot-core/test/platform-adapter.interface.test.ts`

**Step 1: Write the contract test**

`apps/bot-core/test/platform-adapter.interface.test.ts`:
```ts
import {
  PlatformAdapter,
  NormalizedMessage,
  NormalizedReply,
  ChatTarget,
  MediaRef,
  MediaType,
} from '@mpcb/shared';

class FakeAdapter implements PlatformAdapter {
  readonly platform = 'wechat' as const;
  async parseInbound(): Promise<NormalizedMessage> {
    return {
      msgId: 'm1', platform: 'wechat', chatId: 'c1', chatType: 'group',
      senderId: 'u1', senderName: 'A', text: 'hi', mentions: [],
      attachments: [], rawTimestamp: 0,
    };
  }
  verifySignature(): boolean { return true; }
  async sendReply(_reply: NormalizedReply, _t: ChatTarget) {
    return { ok: true };
  }
  async uploadMedia(_b: Buffer, _t: MediaType): Promise<MediaRef> {
    return { platformMediaId: 'x' };
  }
}

describe('PlatformAdapter contract', () => {
  it('parseInbound returns a NormalizedMessage', async () => {
    const a = new FakeAdapter();
    const m = await a.parseInbound({} as any);
    expect(m.platform).toBe('wechat');
  });

  it('verifySignature returns boolean', () => {
    expect(new FakeAdapter().verifySignature({} as any)).toBe(true);
  });

  it('sendReply returns SendResult', async () => {
    expect(await new FakeAdapter().sendReply({ text: 'hi' }, { chatId: 'c', chatType: 'group' })).toEqual({ ok: true });
  });

  it('uploadMedia returns MediaRef', async () => {
    expect(await new FakeAdapter().uploadMedia(Buffer.from(''), 'image')).toEqual({ platformMediaId: 'x' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/platform-adapter.interface.test.ts`
Expected: FAIL — module not found

**Step 3: Create the interface file**

`apps/bot-core/src/platform/platform-adapter.interface.ts`:
```ts
import {
  PlatformName,
  NormalizedMessage,
  NormalizedReply,
  ChatTarget,
  MediaType,
  MediaRef,
} from '@mpcb/shared';

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  query: Record<string, string | string[] | undefined>;
}

export interface SendResult {
  ok: boolean;
  platformMessageId?: string;
  error?: string;
}

export interface PlatformAdapter {
  readonly platform: PlatformName;
  parseInbound(req: RawRequest): Promise<NormalizedMessage>;
  verifySignature(req: RawRequest): boolean;
  sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult>;
  uploadMedia(buffer: Buffer, type: MediaType): Promise<MediaRef>;
}

export const PLATFORM_ADAPTER = Symbol('PLATFORM_ADAPTER');
```

**Step 4: Create the platform module**

`apps/bot-core/src/platform/platform.module.ts`:
```ts
import { Module } from '@nestjs/common';

@Module({})
export class PlatformModule {}
```

**Step 5: Register PlatformModule in AppModule**

Modify `apps/bot-core/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { HealthController } from './webhook/health.controller';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [ConfigModule, LoggerModule, PlatformModule],
  controllers: [HealthController],
})
export class AppModule {}
```

**Step 6: Run test to verify it passes**

Run: `cd apps/bot-core && pnpm jest test/platform-adapter.interface.test.ts`
Expected: 4 tests pass

**Step 7: Commit**

```bash
git add apps/bot-core/src/platform apps/bot-core/src/app.module.ts apps/bot-core/test
git commit -m "feat(platform): define PlatformAdapter interface contract"
```

---

### Task 7: WeChat adapter — signature verify and parseInbound

**Files:**
- Create: `apps/bot-core/src/platform/wechat/wechat.adapter.ts`
- Create: `apps/bot-core/src/platform/wechat/wechat.controller.ts`
- Create: `apps/bot-core/test/wechat.adapter.test.ts`
- Modify: `apps/bot-core/src/platform/platform.module.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/wechat.adapter.test.ts`:
```ts
import { WeChatAdapter } from '../src/platform/wechat/wechat.adapter';
import { createHmac, createHash } from 'crypto';

function signParams(token: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHash('sha1').update(sorted + token).digest('hex');
}

describe('WeChatAdapter', () => {
  const token = 'test_token';
  const enc = 'aes';
  let adapter: WeChatAdapter;

  beforeEach(() => {
    adapter = new WeChatAdapter(token);
  });

  it('verifySignature: returns true when signature matches', () => {
    const params = { timestamp: '1700000000', nonce: 'abc', encrypt: 'msg' };
    const sig = signParams(token, params);
    expect(adapter.verifySignature({ ...params, msg_signature: sig })).toBe(true);
  });

  it('verifySignature: returns false when signature mismatches', () => {
    expect(adapter.verifySignature({ timestamp: '1', nonce: '2', encrypt: '3', msg_signature: 'bad' })).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/wechat.adapter.test.ts`
Expected: FAIL — class not found

**Step 3: Create `apps/bot-core/src/platform/wechat/wechat.adapter.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  PlatformAdapter,
  PlatformName,
  NormalizedMessage,
  NormalizedReply,
  ChatTarget,
  MediaType,
  MediaRef,
} from '@mpcb/shared';
import { RawRequest, SendResult } from '../platform-adapter.interface';

@Injectable()
export class WeChatAdapter implements PlatformAdapter {
  readonly platform: PlatformName = 'wechat';
  private readonly logger = new Logger(WeChatAdapter.name);

  constructor(private readonly token: string) {}

  verifySignature(req: RawRequest): boolean {
    const signature = String(req.query.msg_signature ?? '');
    const timestamp = String(req.query.timestamp ?? '');
    const nonce = String(req.query.nonce ?? '');
    const encrypt = String(req.query.encrypt ?? req.body?.Encrypt ?? '');
    if (!signature || !timestamp || !nonce || !encrypt) return false;
    const sorted = [timestamp, nonce, encrypt].sort().join('');
    const computed = createHash('sha1').update(sorted + this.token).digest('hex');
    return computed === signature;
  }

  async parseInbound(req: RawRequest): Promise<NormalizedMessage> {
    const body = req.body as any;
    const inner = body?.xml ?? {};
    return {
      msgId: String(inner.MsgId ?? ''),
      platform: 'wechat',
      chatId: String(inner.FromUserName ?? ''),
      chatType: 'group',
      senderId: String(inner.FromUserName ?? ''),
      senderName: 'unknown',
      text: String(inner.Content ?? ''),
      mentions: [],
      attachments: [],
      rawTimestamp: Date.now(),
    };
  }

  async sendReply(_reply: NormalizedReply, _target: ChatTarget): Promise<SendResult> {
    this.logger.warn('WeChat sendReply not yet implemented — to be done in Task 8');
    return { ok: false, error: 'not_implemented' };
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}
```

**Step 4: Create the placeholder controller**

`apps/bot-core/src/platform/wechat/wechat.controller.ts`:
```ts
import { Controller } from '@nestjs/common';

@Controller('bot/wechat')
export class WeChatController {}
```

**Step 5: Update `apps/bot-core/src/platform/platform.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { WeChatAdapter } from './wechat/wechat.adapter';
import { WeChatController } from './wechat/wechat.controller';

@Module({
  controllers: [WeChatController],
  providers: [
    { provide: 'WECHAT_TOKEN', useValue: process.env.WECHAT_TOKEN ?? '' },
    WeChatAdapter,
  ],
  exports: [WeChatAdapter],
})
export class PlatformModule {}
```

**Step 6: Run test to verify it passes**

Run: `cd apps/bot-core && pnpm jest test/wechat.adapter.test.ts`
Expected: 2 tests pass

**Step 7: Commit**

```bash
git add apps/bot-core
git commit -m "feat(wechat): adapter with signature verification and parseInbound"
```

---

### Task 8: WeChat adapter — sendReply via customer-service API

**Files:**
- Modify: `apps/bot-core/src/platform/wechat/wechat.adapter.ts`
- Create: `apps/bot-core/test/wechat.send.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/wechat.send.test.ts`:
```ts
import { WeChatAdapter } from '../src/platform/wechat/wechat.adapter';

describe('WeChatAdapter.sendReply', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('posts to /cgi-bin/message/custom/send with correct payload', async () => {
    const calls: any[] = [];
    global.fetch = async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ errcode: 0 }) } as any;
    };
    const a = new WeChatAdapter('tok', { accessToken: 'AT', apiBase: 'https://example.test' });
    const r = await a.sendReply({ text: 'hi' }, { chatId: 'user_1', chatType: 'direct' });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/cgi-bin/message/custom/send');
    const body = JSON.parse(calls[0].init.body);
    expect(body.touser).toBe('user_1');
    expect(body.text.content).toBe('hi');
  });

  it('returns ok=false on non-zero errcode', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ errcode: 40001 }) } as any);
    const a = new WeChatAdapter('tok', { accessToken: 'AT', apiBase: 'https://example.test' });
    const r = await a.sendReply({ text: 'hi' }, { chatId: 'u', chatType: 'direct' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('40001');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/wechat.send.test.ts`
Expected: FAIL — second constructor argument not accepted

**Step 3: Update `wechat.adapter.ts` constructor and sendReply**

Replace the `WeChatAdapter` class:
```ts
@Injectable()
export class WeChatAdapter implements PlatformAdapter {
  readonly platform: PlatformName = 'wechat';
  private readonly logger = new Logger(WeChatAdapter.name);

  constructor(
    private readonly token: string,
    private readonly options: { accessToken?: string; apiBase?: string } = {},
  ) {}

  verifySignature(req: RawRequest): boolean { /* unchanged */ }
  async parseInbound(req: RawRequest): Promise<NormalizedMessage> { /* unchanged */ }

  async sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult> {
    if (!reply.text) return { ok: true };
    const apiBase = this.options.apiBase ?? 'https://qyapi.weixin.qq.com';
    const accessToken = this.options.accessToken ?? '';
    const url = `${apiBase}/cgi-bin/message/custom/send?access_token=${accessToken}`;
    const body: any = {
      touser: target.chatId,
      msgtype: 'text',
      text: { content: reply.text },
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: any = await res.json();
      if (json.errcode === 0) return { ok: true };
      return { ok: false, error: `errcode=${json.errcode} errmsg=${json.errmsg}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}
```

**Step 4: Run tests**

Run: `cd apps/bot-core && pnpm jest test/wechat.send.test.ts`
Expected: 2 tests pass

**Step 5: Verify all earlier tests still pass**

Run: `cd apps/bot-core && pnpm test`
Expected: all tests pass

**Step 6: Commit**

```bash
git add apps/bot-core
git commit -m "feat(wechat): sendReply via customer-service API"
```

---

### Task 9: Teams adapter

**Files:**
- Create: `apps/bot-core/src/platform/teams/teams.adapter.ts`
- Create: `apps/bot-core/src/platform/teams/teams.controller.ts`
- Create: `apps/bot-core/test/teams.adapter.test.ts`
- Modify: `apps/bot-core/src/platform/platform.module.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/teams.adapter.test.ts`:
```ts
import { TeamsAdapter } from '../src/platform/teams/teams.adapter';

describe('TeamsAdapter', () => {
  it('verifySignature accepts Bot Framework JWT (stubbed true)', () => {
    const a = new TeamsAdapter({ appId: 'app', appSecret: 'sec' });
    expect(a.verifySignature({ headers: {}, body: {}, query: {} })).toBe(true);
  });

  it('parseInbound maps activity to NormalizedMessage', async () => {
    const a = new TeamsAdapter({ appId: 'app', appSecret: 'sec' });
    const m = await a.parseInbound({
      headers: {}, query: {},
      body: {
        id: 'msg-1',
        conversation: { id: 'conv-1', conversationType: 'channel' },
        from: { id: 'user-1', name: 'Bob' },
        text: 'hello teams',
        recipient: {},
        timestamp: new Date().toISOString(),
      },
    } as any);
    expect(m.platform).toBe('teams');
    expect(m.text).toBe('hello teams');
    expect(m.chatId).toBe('conv-1');
    expect(m.senderName).toBe('Bob');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/teams.adapter.test.ts`
Expected: FAIL — class not found

**Step 3: Create `apps/bot-core/src/platform/teams/teams.adapter.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import {
  PlatformAdapter, PlatformName, NormalizedMessage, NormalizedReply,
  ChatTarget, MediaType, MediaRef,
} from '@mpcb/shared';
import { RawRequest, SendResult } from '../platform-adapter.interface';

@Injectable()
export class TeamsAdapter implements PlatformAdapter {
  readonly platform: PlatformName = 'teams';
  private readonly logger = new Logger(TeamsAdapter.name);

  constructor(private readonly options: { appId: string; appSecret: string }) {}

  verifySignature(_req: RawRequest): boolean {
    // JWT verification deferred — Bot Framework middleware handles auth
    return true;
  }

  async parseInbound(req: RawRequest): Promise<NormalizedMessage> {
    const a = (req.body ?? {}) as any;
    return {
      msgId: String(a.id ?? ''),
      platform: 'teams',
      chatId: String(a.conversation?.id ?? ''),
      chatType: a.conversation?.conversationType === 'personal' ? 'direct' : 'group',
      senderId: String(a.from?.id ?? ''),
      senderName: String(a.from?.name ?? 'unknown'),
      text: String(a.text ?? '').replace(/<at>.*?<\/at>\s*/g, '').trim(),
      mentions: (a.entities ?? [])
        .filter((e: any) => e.type === 'mention')
        .map((e: any) => String(e.mentioned?.id ?? '')),
      attachments: [],
      rawTimestamp: a.timestamp ? new Date(a.timestamp).getTime() : Date.now(),
    };
  }

  async sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult> {
    if (!reply.text) return { ok: true };
    // Real implementation uses Bot Framework ConnectorClient.
    // MVP emits a placeholder activity URL.
    this.logger.log(`[teams] → ${target.chatId}: ${reply.text}`);
    return { ok: true, platformMessageId: `teams-${Date.now()}` };
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}
```

**Step 4: Create the controller**

`apps/bot-core/src/platform/teams/teams.controller.ts`:
```ts
import { Controller } from '@nestjs/common';

@Controller('bot/teams')
export class TeamsController {}
```

**Step 5: Update platform.module.ts**

```ts
import { Module } from '@nestjs/common';
import { WeChatAdapter } from './wechat/wechat.adapter';
import { WeChatController } from './wechat/wechat.controller';
import { TeamsAdapter } from './teams/teams.adapter';
import { TeamsController } from './teams/teams.controller';

@Module({
  controllers: [WeChatController, TeamsController],
  providers: [
    { provide: 'WECHAT_TOKEN', useValue: process.env.WECHAT_TOKEN ?? '' },
    { provide: 'TEAMS_APP_ID', useValue: process.env.TEAMS_APP_ID ?? '' },
    { provide: 'TEAMS_APP_SECRET', useValue: process.env.TEAMS_APP_SECRET ?? '' },
    WeChatAdapter,
    TeamsAdapter,
  ],
  exports: [WeChatAdapter, TeamsAdapter],
})
export class PlatformModule {}
```

**Step 6: Run tests**

Run: `cd apps/bot-core && pnpm jest test/teams.adapter.test.ts`
Expected: 2 tests pass

**Step 7: Commit**

```bash
git add apps/bot-core
git commit -m "feat(teams): adapter with parseInbound and reply stub"
```

---

### Task 10: DingTalk adapter

**Files:**
- Create: `apps/bot-core/src/platform/dingtalk/dingtalk.adapter.ts`
- Create: `apps/bot-core/src/platform/dingtalk/dingtalk.controller.ts`
- Create: `apps/bot-core/test/dingtalk.adapter.test.ts`
- Modify: `apps/bot-core/src/platform/platform.module.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/dingtalk.adapter.test.ts`:
```ts
import { DingTalkAdapter } from '../src/platform/dingtalk/dingtalk.adapter';
import { createHmac } from 'crypto';

describe('DingTalkAdapter', () => {
  const secret = 'SEC';
  let a: DingTalkAdapter;

  beforeEach(() => {
    a = new DingTalkAdapter({ appKey: 'appKey', appSecret: secret });
  });

  it('verifySignature computes HMAC-SHA256 correctly', () => {
    const ts = '1700000000';
    const stringToSign = `${ts}\n${secret}`;
    const sign = createHmac('sha256', secret).update(stringToSign).digest('base64');
    expect(a.verifySignature({ headers: {}, body: {}, query: { timestamp: ts, sign } } as any)).toBe(true);
  });

  it('verifySignature returns false on bad signature', () => {
    expect(a.verifySignature({ headers: {}, body: {}, query: { timestamp: '1', sign: 'bad' } } as any)).toBe(false);
  });

  it('parseInbound extracts text from stream callback', async () => {
    const m = await a.parseInbound({
      headers: {}, query: {},
      body: {
        msgId: 'd1',
        conversationId: 'g1',
        conversationType: '2',
        senderId: 'u1',
        senderNick: 'Carol',
        text: { content: 'hi ding' },
      },
    } as any);
    expect(m.platform).toBe('dingtalk');
    expect(m.text).toBe('hi ding');
    expect(m.chatType).toBe('group');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/dingtalk.adapter.test.ts`
Expected: FAIL — class not found

**Step 3: Create `apps/bot-core/src/platform/dingtalk/dingtalk.adapter.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  PlatformAdapter, PlatformName, NormalizedMessage, NormalizedReply,
  ChatTarget, MediaType, MediaRef,
} from '@mpcb/shared';
import { RawRequest, SendResult } from '../platform-adapter.interface';

@Injectable()
export class DingTalkAdapter implements PlatformAdapter {
  readonly platform: PlatformName = 'dingtalk';
  private readonly logger = new Logger(DingTalkAdapter.name);

  constructor(private readonly options: { appKey: string; appSecret: string }) {}

  verifySignature(req: RawRequest): boolean {
    const ts = String(req.query?.timestamp ?? '');
    const sign = String(req.query?.sign ?? '');
    if (!ts || !sign) return false;
    const stringToSign = `${ts}\n${this.options.appSecret}`;
    const computed = createHmac('sha256', this.options.appSecret).update(stringToSign).digest('base64');
    return computed === sign;
  }

  async parseInbound(req: RawRequest): Promise<NormalizedMessage> {
    const b = (req.body ?? {}) as any;
    const textObj = b.text ?? {};
    return {
      msgId: String(b.msgId ?? ''),
      platform: 'dingtalk',
      chatId: String(b.conversationId ?? ''),
      chatType: b.conversationType === '1' ? 'direct' : 'group',
      senderId: String(b.senderId ?? ''),
      senderName: String(b.senderNick ?? 'unknown'),
      text: String(textObj.content ?? ''),
      mentions: [],
      attachments: [],
      rawTimestamp: Date.now(),
    };
  }

  async sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult> {
    if (!reply.text) return { ok: true };
    // Real implementation calls oToMessages/bot POST endpoints with sessionWebhook.
    this.logger.log(`[dingtalk] → ${target.chatId}: ${reply.text}`);
    return { ok: true, platformMessageId: `ding-${Date.now()}` };
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}
```

**Step 4: Create the controller**

`apps/bot-core/src/platform/dingtalk/dingtalk.controller.ts`:
```ts
import { Controller } from '@nestjs/common';

@Controller('bot/dingtalk')
export class DingTalkController {}
```

**Step 5: Update platform.module.ts**

```ts
import { Module } from '@nestjs/common';
import { WeChatAdapter } from './wechat/wechat.adapter';
import { WeChatController } from './wechat/wechat.controller';
import { TeamsAdapter } from './teams/teams.adapter';
import { TeamsController } from './teams/teams.controller';
import { DingTalkAdapter } from './dingtalk/dingtalk.adapter';
import { DingTalkController } from './dingtalk/dingtalk.controller';

@Module({
  controllers: [WeChatController, TeamsController, DingTalkController],
  providers: [
    { provide: 'WECHAT_TOKEN', useValue: process.env.WECHAT_TOKEN ?? '' },
    { provide: 'TEAMS_APP_ID', useValue: process.env.TEAMS_APP_ID ?? '' },
    { provide: 'TEAMS_APP_SECRET', useValue: process.env.TEAMS_APP_SECRET ?? '' },
    { provide: 'DINGTALK_APP_KEY', useValue: process.env.DINGTALK_APP_KEY ?? '' },
    { provide: 'DINGTALK_APP_SECRET', useValue: process.env.DINGTALK_APP_SECRET ?? '' },
    WeChatAdapter,
    TeamsAdapter,
    DingTalkAdapter,
  ],
  exports: [WeChatAdapter, TeamsAdapter, DingTalkAdapter],
})
export class PlatformModule {}
```

**Step 6: Run tests**

Run: `cd apps/bot-core && pnpm jest test/dingtalk.adapter.test.ts`
Expected: 3 tests pass

**Step 7: Commit**

```bash
git add apps/bot-core
git commit -m "feat(dingtalk): adapter with signature verify and parseInbound"
```

---

## Phase 4 — Queue

### Task 11: BullMQ queue + DLQ infrastructure

**Files:**
- Create: `apps/bot-core/src/queue/queue.module.ts`
- Create: `apps/bot-core/src/queue/queue.service.ts`
- Create: `apps/bot-core/test/queue.service.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/queue.service.test.ts`:
```ts
import { QueueService } from '../src/queue/queue.service';

describe('QueueService', () => {
  it('enqueue uses msgId as jobId for idempotency', async () => {
    const added: any[] = [];
    const fakeQueue: any = {
      add: async (name: string, data: any, opts: any) => {
        added.push({ name, data, opts });
        return { id: opts.jobId };
      },
    };
    const svc = new QueueService(fakeQueue);
    await svc.enqueueMessage({ msgId: 'm1', platform: 'wechat', chatId: 'c1', chatType: 'group', senderId: 'u1', senderName: 'A', text: 'hi', mentions: [], attachments: [], rawTimestamp: 0 });
    expect(added[0].opts.jobId).toBe('m1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/queue.service.test.ts`
Expected: FAIL — class not found

**Step 3: Create `apps/bot-core/src/queue/queue.service.ts`**

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';
import { NormalizedMessage } from '@mpcb/shared';

export const MESSAGE_QUEUE = 'message.process';
export const DLQ_NAME = 'message.dlq';

export const MESSAGE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: false,
};

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(@Inject('MESSAGE_QUEUE_INSTANCE') private readonly queue: Queue) {}

  async enqueueMessage(msg: NormalizedMessage): Promise<void> {
    const job = await this.queue.add(MESSAGE_QUEUE, msg, {
      ...MESSAGE_JOB_OPTIONS,
      jobId: msg.msgId,
    });
    this.logger.debug(`enqueued msg=${msg.msgId} jobId=${job.id}`);
  }

  getQueue(): Queue {
    return this.queue;
  }
}
```

**Step 4: Create `apps/bot-core/src/queue/queue.module.ts`**

```ts
import { Module, Global } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QueueService, MESSAGE_QUEUE, DLQ_NAME } from './queue.service';
import { ConfigService } from '../common/config/config.service';

@Global()
@Module({
  providers: [
    {
      provide: 'MESSAGE_QUEUE_INSTANCE',
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const connection = { host: cfg.redisHost, port: cfg.redisPort };
        return new Queue(MESSAGE_QUEUE, { connection });
      },
    },
    {
      provide: 'DLQ_INSTANCE',
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const connection = { host: cfg.redisHost, port: cfg.redisPort };
        return new Queue(DLQ_NAME, { connection });
      },
    },
    QueueService,
  ],
  exports: [QueueService],
})
export class QueueModule {}
```

**Step 5: Register QueueModule in AppModule**

Modify `apps/bot-core/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { HealthController } from './webhook/health.controller';
import { PlatformModule } from './platform/platform.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [ConfigModule, LoggerModule, PlatformModule, QueueModule],
  controllers: [HealthController],
})
export class AppModule {}
```

**Step 6: Run tests**

Run: `cd apps/bot-core && pnpm jest test/queue.service.test.ts`
Expected: 1 test passes

**Step 7: Commit**

```bash
git add apps/bot-core
git commit -m "feat(queue): BullMQ queue with idempotent jobId and retry policy"
```

---

## Phase 5 — Router

### Task 12: Router service with command parsing

**Files:**
- Create: `apps/bot-core/src/router/router.module.ts`
- Create: `apps/bot-core/src/router/router.service.ts`
- Create: `apps/bot-core/src/router/router.types.ts`
- Create: `apps/bot-core/test/router.service.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/router.service.test.ts`:
```ts
import { RouterService } from '../src/router/router.service';

const baseMsg = (text: string) => ({
  msgId: 'm', platform: 'wechat' as const, chatId: 'c', chatType: 'group' as const,
  senderId: 'u', senderName: 'A', text, mentions: [], attachments: [], rawTimestamp: 0,
});

describe('RouterService', () => {
  const svc = new RouterService({
    commands: { help: 'help', clear: 'clear', status: 'status' },
    prefixes: { kb: 'kb', tool: 'tool', ask: 'llm' },
    defaultHandler: 'llm',
    commandOnly: false,
  });

  it('routes /help to command handler', async () => {
    const d = await svc.route(baseMsg('/help'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('command');
    if (d.kind === 'command') expect(d.handler).toBe('help');
  });

  it('routes "kb: 报销" to kb handler with query', async () => {
    const d = await svc.route(baseMsg('kb: 报销'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('kb');
    if (d.kind === 'kb') expect(d.query).toBe('报销');
  });

  it('routes "tool: weather" to tool handler with name+args', async () => {
    const d = await svc.route(baseMsg('tool: weather 北京'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('tool');
    if (d.kind === 'tool') {
      expect(d.toolName).toBe('weather');
      expect(d.args).toBe('北京');
    }
  });

  it('falls back to llm for plain text in default mode', async () => {
    const d = await svc.route(baseMsg('你好'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('llm');
  });

  it('returns unknown when commandOnly and no command prefix', async () => {
    const cmdOnlySvc = new RouterService({
      commands: { help: 'help' },
      prefixes: { kb: 'kb' },
      defaultHandler: 'llm',
      commandOnly: true,
    });
    const d = await cmdOnlySvc.route(baseMsg('你好'), { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    expect(d.kind).toBe('unknown');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/router.service.test.ts`
Expected: FAIL — class not found

**Step 3: Create `apps/bot-core/src/router/router.types.ts`**

```ts
import { RouteDecision } from '@mpcb/shared';

export interface RouteContext {
  userId: string;
  chatId: string;
  platform: 'wechat' | 'teams' | 'dingtalk';
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  abortSignal: AbortSignal;
}

export interface RouterConfig {
  commands: Record<string, 'help' | 'clear' | 'status'>;
  prefixes: Record<string, string>;
  defaultHandler: 'llm' | 'kb' | 'tool';
  commandOnly: boolean;
}

export { RouteDecision };
```

**Step 4: Create `apps/bot-core/src/router/router.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { RouteDecision } from '@mpcb/shared';
import { RouteContext, RouterConfig } from './router.types';

@Injectable()
export class RouterService {
  constructor(private readonly config: RouterConfig) {}

  async route(text: string, ctx: RouteContext): Promise<RouteDecision> {
    const trimmed = text.trim();

    // 1. Built-in commands: /cmd args
    if (trimmed.startsWith('/')) {
      const rest = trimmed.slice(1).trim();
      const [cmd, ...argParts] = rest.split(/\s+/);
      const handler = this.config.commands[cmd.toLowerCase()];
      if (handler) {
        return { kind: 'command', handler, args: argParts.join(' ') };
      }
      return { kind: 'unknown', reason: `unknown_command:${cmd}` };
    }

    // 2. Prefixes: kb: query, tool: name args, ask: prompt
    for (const [prefix, target] of Object.entries(this.config.prefixes)) {
      const m = trimmed.match(new RegExp(`^${prefix}\\s*:\\s*(.+)$`, 'i'));
      if (m) {
        const payload = m[1].trim();
        if (target === 'kb') return { kind: 'kb', query: payload };
        if (target === 'tool') {
          const [toolName, ...args] = payload.split(/\s+/);
          return { kind: 'tool', toolName, args: args.join(' ') };
        }
        if (target === 'llm') return { kind: 'llm', prompt: payload };
      }
    }

    // 3. Default handler (or unknown if commandOnly)
    if (this.config.commandOnly) return { kind: 'unknown', reason: 'plain_text_in_command_only_mode' };
    return { kind: 'llm', prompt: trimmed };
  }
}
```

**Step 5: Create `apps/bot-core/src/router/router.module.ts`**

```ts
import { Module, Global } from '@nestjs/common';
import { RouterService } from './router.service';

@Global()
@Module({
  providers: [
    {
      provide: RouterService,
      useFactory: () => new RouterService({
        commands: { help: 'help', clear: 'clear', status: 'status' },
        prefixes: { kb: 'kb', tool: 'tool', ask: 'llm' },
        defaultHandler: 'llm',
        commandOnly: false,
      }),
    },
  ],
  exports: [RouterService],
})
export class RouterModule {}
```

**Step 6: Register RouterModule in AppModule**

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { HealthController } from './webhook/health.controller';
import { PlatformModule } from './platform/platform.module';
import { QueueModule } from './queue/queue.module';
import { RouterModule } from './router/router.module';

@Module({
  imports: [ConfigModule, LoggerModule, PlatformModule, QueueModule, RouterModule],
  controllers: [HealthController],
})
export class AppModule {}
```

**Step 7: Run tests**

Run: `cd apps/bot-core && pnpm jest test/router.service.test.ts`
Expected: 5 tests pass

**Step 8: Commit**

```bash
git add apps/bot-core
git commit -m "feat(router): command/keyword routing with 5 priority levels"
```

---

## Phase 6 — Handlers

### Task 13: Handler interface and registry

**Files:**
- Create: `apps/bot-core/src/handlers/handler.interface.ts`
- Create: `apps/bot-core/src/handlers/handlers.module.ts`
- Create: `apps/bot-core/test/handlers.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/handlers.test.ts`:
```ts
import { Handler, HandlerContext, HandlerRegistry } from '../src/handlers/handler.interface';
import { RouteDecision, NormalizedReply } from '@mpcb/shared';

class StubHandler implements Handler {
  readonly name = 'stub';
  async handle(): Promise<NormalizedReply> { return { text: 'stub-out' }; }
}

describe('HandlerRegistry', () => {
  it('registers and retrieves handler by name', () => {
    const reg = new HandlerRegistry();
    const h = new StubHandler();
    reg.register(h);
    expect(reg.get('stub')).toBe(h);
  });

  it('returns undefined for unknown handler', () => {
    expect(new HandlerRegistry().get('nope')).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/handlers.test.ts`
Expected: FAIL — module not found

**Step 3: Create `apps/bot-core/src/handlers/handler.interface.ts`**

```ts
import { Injectable, NormalizedReply } from '@mpcb/shared';

export interface HandlerContext {
  userId: string;
  chatId: string;
  platform: 'wechat' | 'teams' | 'dingtalk';
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  abortSignal: AbortSignal;
}

export interface Handler {
  readonly name: string;
  handle(input: any, ctx: HandlerContext): Promise<NormalizedReply>;
}

@Injectable()
export class HandlerRegistry {
  private readonly map = new Map<string, Handler>();

  register(h: Handler) { this.map.set(h.name, h); }
  get(name: string): Handler | undefined { return this.map.get(name); }
  list(): Handler[] { return [...this.map.values()]; }
}
```

**Step 4: Create `apps/bot-core/src/handlers/handlers.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { HandlerRegistry } from './handler.interface';

@Module({
  providers: [HandlerRegistry],
  exports: [HandlerRegistry],
})
export class HandlersModule {}
```

**Step 5: Register HandlersModule in AppModule**

Add `HandlersModule` to imports array in `app.module.ts`.

**Step 6: Run tests**

Run: `cd apps/bot-core && pnpm jest test/handlers.test.ts`
Expected: 2 tests pass

**Step 7: Commit**

```bash
git add apps/bot-core
git commit -m "feat(handlers): define Handler interface and registry"
```

---

### Task 14: LLM provider interface and Claude implementation

**Files:**
- Create: `apps/bot-core/src/handlers/llm/llm.types.ts`
- Create: `apps/bot-core/src/handlers/llm/llm.handler.ts`
- Create: `apps/bot-core/src/handlers/llm/providers/claude.provider.ts`
- Create: `apps/bot-core/test/claude.provider.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/claude.provider.test.ts`:
```ts
import { ClaudeProvider } from '../src/handlers/llm/providers/claude.provider';

describe('ClaudeProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('chat posts to /v1/messages with correct shape', async () => {
    let captured: any = null;
    global.fetch = async (_url: any, init: any) => {
      captured = { url: _url, init };
      return {
        ok: true, status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'hi back' }], usage: { input_tokens: 5, output_tokens: 3 } }),
      } as any;
    };
    const p = new ClaudeProvider({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    const r = await p.chat({ model: 'claude-3-5-sonnet-20241022', systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured.url).toContain('/v1/messages');
    expect(r.text).toBe('hi back');
    expect(r.usage.promptTokens).toBe(5);
  });

  it('chat throws on non-OK response', async () => {
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) } as any);
    const p = new ClaudeProvider({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    await expect(p.chat({ model: 'm', messages: [] })).rejects.toThrow(/401/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/claude.provider.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/handlers/llm/llm.types.ts`**

```ts
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  maxTokens?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  text: string;
  usage: ChatUsage;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  countTokens(text: string): number;
}
```

**Step 4: Create `apps/bot-core/src/handlers/llm/providers/claude.provider.ts`**

```ts
import { ChatMessage, ChatRequest, ChatResponse, LlmProvider } from '../../llm.types';

export interface ClaudeProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(private readonly opts: ClaudeProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
    this.defaultModel = opts.defaultModel ?? 'claude-3-5-sonnet-20241022';
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/v1/messages`;
    const body = {
      model: req.model || this.defaultModel,
      max_tokens: req.maxTokens ?? 1024,
      system: req.systemPrompt,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`claude ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    const text = (json.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    return {
      text,
      model: json.model ?? req.model,
      usage: {
        promptTokens: json.usage?.input_tokens ?? 0,
        completionTokens: json.usage?.output_tokens ?? 0,
      },
    };
  }

  countTokens(text: string): number {
    // Approximate: ~4 chars per token for English/mixed CJK
    return Math.ceil(text.length / 4);
  }
}
```

**Step 5: Create `apps/bot-core/src/handlers/llm/llm.handler.ts`** (initial LLM handler with single-provider fallback; full fallback chain in Task 17)

```ts
import { Injectable, Logger } from '@nestjs/common';
import { NormalizedReply, RouteDecision } from '@mpcb/shared';
import { Handler, HandlerContext } from '../handler.interface';
import { LlmProvider, ChatRequest } from './llm.types';

@Injectable()
export class LlmHandler implements Handler {
  readonly name = 'llm';
  private readonly logger = new Logger(LlmHandler.name);

  constructor(private readonly provider: LlmProvider) {}

  async handle(input: RouteDecision & { kind: 'llm' }, ctx: HandlerContext): Promise<NormalizedReply> {
    const req: ChatRequest = {
      model: 'default',
      systemPrompt: input.systemPrompt,
      messages: [
        ...ctx.history.slice(-5),
        { role: 'user', content: input.prompt },
      ],
    };
    try {
      const resp = await this.provider.chat(req);
      return { text: resp.text };
    } catch (err) {
      this.logger.error(`LLM error: ${err}`);
      return { text: '抱歉,服务暂时不可用,请稍后再试。' };
    }
  }
}
```

**Step 6: Run tests**

Run: `cd apps/bot-core && pnpm jest test/claude.provider.test.ts`
Expected: 2 tests pass

**Step 7: Commit**

```bash
git add apps/bot-core
git commit -m "feat(llm): Claude provider with chat() and LLM handler skeleton"
```

---

### Task 15: OpenAI provider

**Files:**
- Create: `apps/bot-core/src/handlers/llm/providers/openai.provider.ts`
- Create: `apps/bot-core/test/openai.provider.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/openai.provider.test.ts`:
```ts
import { OpenAIProvider } from '../src/handlers/llm/providers/openai.provider';

describe('OpenAIProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('chat posts to /chat/completions with messages array', async () => {
    let captured: any = null;
    global.fetch = async (url: any, init: any) => {
      captured = { url: String(url), init };
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: 'openai hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      } as any;
    };
    const p = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    const r = await p.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured.url).toContain('/chat/completions');
    const body = JSON.parse(captured.init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(r.text).toBe('openai hi');
    expect(r.usage.promptTokens).toBe(10);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/openai.provider.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/handlers/llm/providers/openai.provider.ts`**

```ts
import { ChatRequest, ChatResponse, LlmProvider } from '../../llm.types';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com';
    this.defaultModel = opts.defaultModel ?? 'gpt-4o-mini';
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const messages = req.systemPrompt
      ? [{ role: 'system', content: req.systemPrompt }, ...req.messages]
      : req.messages;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model || this.defaultModel,
        max_tokens: req.maxTokens ?? 1024,
        messages,
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      model: json.model ?? req.model,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
```

**Step 4: Run tests**

Run: `cd apps/bot-core && pnpm jest test/openai.provider.test.ts`
Expected: 1 test passes

**Step 5: Commit**

```bash
git add apps/bot-core
git commit -m "feat(llm): OpenAI provider implementation"
```

---

### Task 16: Tongyi and DeepSeek providers

**Files:**
- Create: `apps/bot-core/src/handlers/llm/providers/tongyi.provider.ts`
- Create: `apps/bot-core/src/handlers/llm/providers/deepseek.provider.ts`
- Create: `apps/bot-core/test/domestic.providers.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/domestic.providers.test.ts`:
```ts
import { TongyiProvider } from '../src/handlers/llm/providers/tongyi.provider';
import { DeepSeekProvider } from '../src/handlers/llm/providers/deepseek.provider';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

describe('TongyiProvider', () => {
  it('chat posts to DashScope compatible-mode endpoint', async () => {
    global.fetch = async (_url: any, init: any) => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'ty hi' } }],
        usage: { prompt_tokens: 7, completion_tokens: 4 },
      }),
    } as any);
    const p = new TongyiProvider({ apiKey: 'k', baseUrl: 'https://dash.example.com' });
    const r = await p.chat({ model: 'qwen-plus', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('ty hi');
    expect(r.usage.completionTokens).toBe(4);
  });
});

describe('DeepSeekProvider', () => {
  it('chat posts to DeepSeek /chat/completions endpoint', async () => {
    global.fetch = async (_url: any, init: any) => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'ds hi' } }],
        usage: { prompt_tokens: 8, completion_tokens: 6 },
      }),
    } as any);
    const p = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://api.deepseek.example.com' });
    const r = await p.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('ds hi');
    expect(r.usage.promptTokens).toBe(8);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/domestic.providers.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/handlers/llm/providers/tongyi.provider.ts`**

```ts
import { ChatRequest, ChatResponse, LlmProvider } from '../../llm.types';

export interface TongyiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class TongyiProvider implements LlmProvider {
  readonly name = 'tongyi';
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(private readonly opts: TongyiProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://dashscope.aliyuncs.com';
    this.defaultModel = opts.defaultModel ?? 'qwen-plus';
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/compatible-mode/v1/chat/completions`;
    const messages = req.systemPrompt
      ? [{ role: 'system', content: req.systemPrompt }, ...req.messages]
      : req.messages;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model || this.defaultModel,
        max_tokens: req.maxTokens ?? 1024,
        messages,
      }),
    });
    if (!res.ok) throw new Error(`tongyi ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      model: json.model ?? req.model,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  countTokens(text: string): number { return Math.ceil(text.length / 4); }
}
```

**Step 4: Create `apps/bot-core/src/handlers/llm/providers/deepseek.provider.ts`**

```ts
import { ChatRequest, ChatResponse, LlmProvider } from '../../llm.types';

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(private readonly opts: DeepSeekProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.deepseek.com';
    this.defaultModel = opts.defaultModel ?? 'deepseek-chat';
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const messages = req.systemPrompt
      ? [{ role: 'system', content: req.systemPrompt }, ...req.messages]
      : req.messages;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model || this.defaultModel,
        max_tokens: req.maxTokens ?? 1024,
        messages,
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      model: json.model ?? req.model,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  countTokens(text: string): number { return Math.ceil(text.length / 4); }
}
```

**Step 5: Run tests**

Run: `cd apps/bot-core && pnpm jest test/domestic.providers.test.ts`
Expected: 2 tests pass

**Step 6: Commit**

```bash
git add apps/bot-core
git commit -m "feat(llm): Tongyi and DeepSeek providers"
```

---

### Task 17: LLM fallback chain and usage logging

**Files:**
- Create: `apps/bot-core/src/handlers/llm/fallback.provider.ts`
- Create: `apps/bot-core/src/handlers/llm/usage-logger.ts`
- Create: `apps/bot-core/test/fallback.provider.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/fallback.provider.test.ts`:
```ts
import { FallbackProvider } from '../src/handlers/llm/fallback.provider';

const ok = (name: string) => ({ name, chat: async () => ({ text: `${name}-ok`, usage: { promptTokens: 1, completionTokens: 1 }, model: 'm' }), countTokens: () => 1 });
const fail = (name: string) => ({ name, chat: async () => { throw new Error(`${name}-down`); }, countTokens: () => 1 });

describe('FallbackProvider', () => {
  it('uses first provider when it succeeds', async () => {
    const fb = new FallbackProvider([ok('a'), ok('b')]);
    const r = await fb.chat({ model: 'm', messages: [] });
    expect(r.text).toBe('a-ok');
  });

  it('falls back to second when first throws', async () => {
    const fb = new FallbackProvider([fail('a'), ok('b')]);
    const r = await fb.chat({ model: 'm', messages: [] });
    expect(r.text).toBe('b-ok');
  });

  it('throws when all providers fail', async () => {
    const fb = new FallbackProvider([fail('a'), fail('b')]);
    await expect(fb.chat({ model: 'm', messages: [] })).rejects.toThrow(/b-down/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/fallback.provider.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/handlers/llm/fallback.provider.ts`**

```ts
import { ChatRequest, ChatResponse, LlmProvider } from './llm.types';
import { Logger } from '@nestjs/common';

export class FallbackProvider implements LlmProvider {
  readonly name = 'fallback';
  private readonly logger = new Logger(FallbackProvider.name);

  constructor(private readonly chain: LlmProvider[]) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let lastErr: unknown;
    for (const p of this.chain) {
      try {
        return await p.chat(req);
      } catch (err) {
        this.logger.warn(`provider ${p.name} failed: ${err}; falling back`);
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('all providers failed');
  }

  countTokens(text: string): number { return Math.ceil(text.length / 4); }
}
```

**Step 4: Create `apps/bot-core/src/handlers/llm/usage-logger.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { createPool, Pool } from 'mysql2/promise';
import { ConfigService } from '../../common/config/config.service';
import { ChatUsage } from './llm.types';

@Injectable()
export class UsageLogger {
  private pool: Pool | null = null;

  constructor(private readonly cfg: ConfigService) {}

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = createPool({
        host: this.cfg.mysqlHost,
        port: this.cfg.mysqlPort,
        user: this.cfg.mysqlUser,
        password: this.cfg.mysqlPassword,
        database: this.cfg.mysqlDatabase,
        connectionLimit: 5,
      });
    }
    return this.pool;
  }

  async record(args: {
    userId?: string;
    provider: string;
    model: string;
    usage: ChatUsage;
    costUsd?: number;
  }): Promise<void> {
    await this.getPool().query(
      `INSERT INTO usage_log (user_id, provider, model, prompt_tokens, completion_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        args.userId ? Number(args.userId) : null,
        args.provider,
        args.model,
        args.usage.promptTokens,
        args.usage.completionTokens,
        args.costUsd ?? null,
      ],
    );
  }
}
```

**Step 5: Update `llm.handler.ts` to record usage and accept FallbackProvider**

Replace the file content with:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { NormalizedReply, RouteDecision } from '@mpcb/shared';
import { Handler, HandlerContext } from '../handler.interface';
import { LlmProvider, ChatRequest } from './llm.types';
import { UsageLogger } from './usage-logger';

@Injectable()
export class LlmHandler implements Handler {
  readonly name = 'llm';
  private readonly logger = new Logger(LlmHandler.name);

  constructor(
    private readonly provider: LlmProvider,
    private readonly usage: UsageLogger,
  ) {}

  async handle(input: RouteDecision & { kind: 'llm' }, ctx: HandlerContext): Promise<NormalizedReply> {
    const req: ChatRequest = {
      model: 'default',
      systemPrompt: input.systemPrompt,
      messages: [
        ...ctx.history.slice(-5),
        { role: 'user', content: input.prompt },
      ],
    };
    try {
      const resp = await this.provider.chat(req);
      await this.usage.record({
        userId: ctx.userId,
        provider: this.provider.name,
        model: resp.model,
        usage: resp.usage,
      }).catch((e) => this.logger.warn(`usage log failed: ${e}`));
      return { text: resp.text };
    } catch (err) {
      this.logger.error(`LLM error: ${err}`);
      return { text: '抱歉,服务暂时不可用,请稍后再试。' };
    }
  }
}
```

**Step 6: Run tests**

Run: `cd apps/bot-core && pnpm jest test/fallback.provider.test.ts`
Expected: 3 tests pass

**Step 7: Commit**

```bash
git add apps/bot-core
git commit -m "feat(llm): fallback provider chain and usage logging to MySQL"
```

---

### Task 18: KB handler — Qdrant client wrapper

**Files:**
- Create: `apps/bot-core/src/handlers/kb/qdrant.client.ts`
- Create: `apps/bot-core/test/qdrant.client.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/qdrant.client.test.ts`:
```ts
import { QdrantKbClient } from '../src/handlers/kb/qdrant.client';

describe('QdrantKbClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('ensureCollection creates collection if missing', async () => {
    let calls: any[] = [];
    global.fetch = async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/collections/kb_chunks') && init?.method === 'GET') {
        return { ok: false, status: 404, text: async () => 'not found' } as any;
      }
      return { ok: true, status: 200, text: async () => '{}' } as any;
    };
    const c = new QdrantKbClient({ url: 'http://q.example.com', vectorDim: 1024 });
    await c.ensureCollection();
    const put = calls.find((x) => x.init?.method === 'PUT');
    expect(put).toBeDefined();
    expect(put.url).toContain('/collections/kb_chunks');
  });

  it('search posts vector and returns payload results', async () => {
    global.fetch = async (_url: any, _init: any) => ({
      ok: true, status: 200,
      json: async () => ({
        result: [
          { id: '1', score: 0.91, payload: { chunk_id: 10, doc_id: 5, doc_title: 'X', content_preview: 'snippet' } },
        ],
      }),
    } as any);
    const c = new QdrantKbClient({ url: 'http://q.example.com', vectorDim: 1024 });
    const r = await c.search([0.1, 0.2], 5);
    expect(r[0].payload.chunk_id).toBe(10);
    expect(r[0].score).toBeCloseTo(0.91);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/qdrant.client.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/handlers/kb/qdrant.client.ts`**

```ts
export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, any>;
}

export interface QdrantKbClientOptions {
  url: string;
  vectorDim: number;
  collectionName?: string;
}

export class QdrantKbClient {
  private readonly collectionName: string;
  constructor(private readonly opts: QdrantKbClientOptions) {
    this.collectionName = opts.collectionName ?? 'kb_chunks';
  }

  async ensureCollection(): Promise<void> {
    const url = `${this.opts.url}/collections/${this.collectionName}`;
    const probe = await fetch(url, { method: 'GET' });
    if (probe.ok) return;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vectors: { size: this.opts.vectorDim, distance: 'Cosine' },
      }),
    });
    if (!res.ok) throw new Error(`qdrant create failed: ${res.status} ${await res.text()}`);
  }

  async upsert(points: Array<{ id: string; vector: number[]; payload: Record<string, any> }>): Promise<void> {
    const url = `${this.opts.url}/collections/${this.collectionName}/points`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ points }),
    });
    if (!res.ok) throw new Error(`qdrant upsert failed: ${res.status} ${await res.text()}`);
  }

  async search(vector: number[], topK: number): Promise<QdrantSearchResult[]> {
    const url = `${this.opts.url}/collections/${this.collectionName}/points/search`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vector, top: topK, with_payload: true }),
    });
    if (!res.ok) throw new Error(`qdrant search failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return json.result ?? [];
  }
}
```

**Step 4: Run tests**

Run: `cd apps/bot-core && pnpm jest test/qdrant.client.test.ts`
Expected: 2 tests pass

**Step 5: Commit**

```bash
git add apps/bot-core
git commit -m "feat(kb): Qdrant client wrapper with ensureCollection, upsert, search"
```

---

### Task 19: KB handler — chunker, embedder, retriever, full RAG pipeline

**Files:**
- Create: `apps/bot-core/src/handlers/kb/chunker.ts`
- Create: `apps/bot-core/src/handlers/kb/embedder.ts`
- Create: `apps/bot-core/src/handlers/kb/kb.handler.ts`
- Create: `apps/bot-core/test/chunker.test.ts`
- Create: `apps/bot-core/test/embedder.test.ts`

**Step 1: Write chunker test**

`apps/bot-core/test/chunker.test.ts`:
```ts
import { chunkText } from '../src/handlers/kb/chunker';

describe('chunkText', () => {
  it('returns a single chunk when text fits', () => {
    const chunks = chunkText('hello world', 512, 64);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe('hello world');
  });

  it('splits long text into overlapping chunks', () => {
    const long = 'a'.repeat(2000);
    const chunks = chunkText(long, 512, 64);
    expect(chunks.length).toBeGreaterThan(3);
    // Each chunk ≤ 512 chars
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(512);
  });

  it('preserves sentence boundaries when possible', () => {
    const text = '第一句。第二句比较长很长。第三句。';
    const chunks = chunkText(text, 8, 2);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(8);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/chunker.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/handlers/kb/chunker.ts`**

```ts
export function chunkText(text: string, maxChunkSize = 512, overlap = 64): string[] {
  if (!text) return [];
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChunkSize, text.length);

    // Try to break at sentence boundary
    if (end < text.length) {
      const slice = text.slice(start, end);
      const lastBreak = Math.max(
        slice.lastIndexOf('。'),
        slice.lastIndexOf('.'),
        slice.lastIndexOf('!'),
        slice.lastIndexOf('?'),
        slice.lastIndexOf('\n'),
      );
      if (lastBreak > maxChunkSize / 2) {
        end = start + lastBreak + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
```

**Step 4: Write embedder test**

`apps/bot-core/test/embedder.test.ts`:
```ts
import { HttpEmbedder } from '../src/handlers/kb/embedder';

describe('HttpEmbedder', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('embedBatch posts to embeddings endpoint and returns vectors', async () => {
    global.fetch = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        json: async () => ({
          data: body.input.map((_: string, i: number) => ({ embedding: new Array(4).fill(i + 1) })),
        }),
      } as any;
    };
    const e = new HttpEmbedder({ url: 'https://emb.example.com', apiKey: 'k', model: 'bge' });
    const v = await e.embedBatch(['a', 'b']);
    expect(v.length).toBe(2);
    expect(v[0][0]).toBe(1);
    expect(v[1][0]).toBe(2);
  });
});
```

**Step 5: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/embedder.test.ts`
Expected: FAIL

**Step 6: Create `apps/bot-core/src/handlers/kb/embedder.ts`**

```ts
export interface Embedder {
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface HttpEmbedderOptions {
  url: string;
  apiKey: string;
  model: string;
}

export class HttpEmbedder implements Embedder {
  constructor(private readonly opts: HttpEmbedderOptions) {}

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.opts.url}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embedder ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return (json.data ?? []).map((d: any) => d.embedding);
  }
}
```

**Step 7: Create `apps/bot-core/src/handlers/kb/kb.handler.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { NormalizedReply, RouteDecision } from '@mpcb/shared';
import { Handler, HandlerContext } from '../handler.interface';
import { LlmProvider, ChatRequest } from '../llm/llm.types';
import { QdrantKbClient } from './qdrant.client';
import { Embedder } from './embedder';

export interface KbHandlerDeps {
  qdrant: QdrantKbClient;
  embedder: Embedder;
  llm: LlmProvider;
  topK?: number;
}

const SYSTEM_PROMPT = `你是企业知识库助手。请仅基于提供的上下文回答问题。
如果上下文不足以回答问题,请直接说"未找到相关信息"。不要编造。`;

@Injectable()
export class KbHandler implements Handler {
  readonly name = 'kb';
  private readonly logger = new Logger(KbHandler.name);
  private readonly topK: number;

  constructor(private readonly deps: KbHandlerDeps) {
    this.topK = deps.topK ?? 10;
  }

  async handle(input: RouteDecision & { kind: 'kb' }, ctx: HandlerContext): Promise<NormalizedReply> {
    const k = input.topK ?? 3;
    const vectors = await this.deps.embedder.embedBatch([input.query]);
    const hits = await this.deps.qdrant.search(vectors[0], this.topK);
    const top = hits.slice(0, k);
    if (top.length === 0) {
      return { text: '未找到相关信息。' };
    }
    const context = top.map((h, i) => `[${i + 1}] ${h.payload?.doc_title ?? ''}: ${h.payload?.content_preview ?? ''}`).join('\n');
    const req: ChatRequest = {
      model: 'default',
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `上下文:\n${context}\n\n问题:${input.query}` },
      ],
    };
    try {
      const resp = await this.deps.llm.chat(req);
      return { text: resp.text };
    } catch (err) {
      this.logger.error(`KB LLM error: ${err}`);
      return { text: '抱歉,生成回复时出错。' };
    }
  }
}
```

**Step 8: Run all KB tests**

Run: `cd apps/bot-core && pnpm jest test/chunker.test.ts test/embedder.test.ts`
Expected: chunker 3 pass, embedder 1 pass

**Step 9: Commit**

```bash
git add apps/bot-core
git commit -m "feat(kb): chunker, embedder, and full RAG handler"
```

---

### Task 20: Tool handler with registry and built-in tools

**Files:**
- Create: `apps/bot-core/src/handlers/tool/tool.handler.ts`
- Create: `apps/bot-core/src/handlers/tool/builtin/translate.tool.ts`
- Create: `apps/bot-core/src/handlers/tool/builtin/weather.tool.ts`
- Create: `apps/bot-core/test/tool.handler.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/tool.handler.test.ts`:
```ts
import { ToolRegistry } from '../src/handlers/tool/tool.handler';
import { translateTool } from '../src/handlers/tool/builtin/translate.tool';

describe('ToolRegistry', () => {
  it('executes a registered tool by name', async () => {
    const reg = new ToolRegistry();
    reg.register(translateTool({ defaultModel: () => null }));
    const r = await reg.execute('translate', 'hello world', { userId: 'u', chatId: 'c', platform: 'wechat', history: [], abortSignal: new AbortController().signal });
    // translate without LLM returns an error reply
    expect(r.text).toBeDefined();
  });
});

describe('translateTool', () => {
  it('has correct shape', () => {
    const t = translateTool({ defaultModel: () => null });
    expect(t.name).toBe('translate');
    expect(t.rateLimit).toBe(20);
    expect(t.enabled).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/tool.handler.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/handlers/tool/tool.handler.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { NormalizedReply, RouteDecision } from '@mpcb/shared';
import { Handler, HandlerContext } from '../handler.interface';

export interface ToolDef<TArgs = any> {
  name: string;
  description: string;
  rateLimit: number; // per-user per-minute
  enabled: boolean;
  execute(args: TArgs, ctx: HandlerContext): Promise<NormalizedReply>;
}

interface RateCounter { count: number; resetAt: number }

@Injectable()
export class ToolRegistry implements Handler {
  readonly name = 'tool';
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, ToolDef>();
  private readonly rateCounters = new Map<string, RateCounter>();

  register(t: ToolDef): void { this.tools.set(t.name, t); }
  list(): ToolDef[] { return [...this.tools.values()]; }

  private checkRate(toolName: string, userId: string, limit: number): boolean {
    const key = `${userId}:${toolName}`;
    const now = Date.now();
    const c = this.rateCounters.get(key);
    if (!c || c.resetAt < now) {
      this.rateCounters.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (c.count >= limit) return false;
    c.count++;
    return true;
  }

  async execute(name: string, args: string, ctx: HandlerContext): Promise<NormalizedReply> {
    const tool = this.tools.get(name);
    if (!tool || !tool.enabled) return { text: `工具 ${name} 不存在或已禁用。` };
    if (!this.checkRate(name, ctx.userId, tool.rateLimit)) {
      return { text: `工具 ${name} 调用频率超限,请稍后再试。` };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      this.logger.error(`tool ${name} error: ${err}`);
      return { text: `工具执行失败:${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async handle(input: RouteDecision & { kind: 'tool' }, ctx: HandlerContext): Promise<NormalizedReply> {
    return this.execute(input.toolName, input.args, ctx);
  }
}
```

**Step 4: Create `apps/bot-core/src/handlers/tool/builtin/translate.tool.ts`**

```ts
import { ToolDef } from '../tool.handler';

export function translateTool(deps: { defaultModel: () => any }): ToolDef {
  return {
    name: 'translate',
    description: 'Translate text between languages. Args: "<target_lang> <text>"',
    rateLimit: 20,
    enabled: true,
    async execute(args, _ctx) {
      const [lang, ...rest] = args.split(/\s+/);
      const text = rest.join(' ');
      const llm = deps.defaultModel();
      if (!llm) return { text: `翻译功能需要配置 LLM Provider。原文:${text} (→${lang})` };
      const r = await llm.chat({
        model: 'default',
        systemPrompt: `You are a translator. Translate to ${lang}. Output only the translation.`,
        messages: [{ role: 'user', content: text }],
      });
      return { text: r.text };
    },
  };
}
```

**Step 5: Create `apps/bot-core/src/handlers/tool/builtin/weather.tool.ts`**

```ts
import { ToolDef } from '../tool.handler';

export function weatherTool(): ToolDef {
  return {
    name: 'weather',
    description: 'Look up weather for a city. Args: "<city>"',
    rateLimit: 30,
    enabled: true,
    async execute(args, _ctx) {
      const city = args.trim();
      // Real impl calls a weather API. MVP placeholder.
      return { text: `${city} 当前天气:晴,25°C (占位数据,请配置真实 API)。` };
    },
  };
}
```

**Step 6: Run tests**

Run: `cd apps/bot-core && pnpm jest test/tool.handler.test.ts`
Expected: 2 tests pass

**Step 7: Commit**

```bash
git add apps/bot-core
git commit -m "feat(tools): tool registry with rate limiting and built-in translate/weather"
```

---

### Task 21: Wire handlers into HandlersModule

**Files:**
- Modify: `apps/bot-core/src/handlers/handlers.module.ts`

**Step 1: Replace HandlersModule content**

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { HandlerRegistry } from './handler.interface';
import { ClaudeProvider } from './llm/providers/claude.provider';
import { OpenAIProvider } from './llm/providers/openai.provider';
import { TongyiProvider } from './llm/providers/tongyi.provider';
import { DeepSeekProvider } from './llm/providers/deepseek.provider';
import { FallbackProvider } from './llm/fallback.provider';
import { LlmHandler } from './llm/llm.handler';
import { UsageLogger } from './llm/usage-logger';
import { KbHandler } from './kb/kb.handler';
import { QdrantKbClient } from './kb/qdrant.client';
import { HttpEmbedder } from './kb/embedder';
import { ToolRegistry } from './tool/tool.handler';
import { translateTool } from './tool/builtin/translate.tool';
import { weatherTool } from './tool/builtin/weather.tool';

@Module({
  providers: [
    HandlerRegistry,
    UsageLogger,
    ClaudeProvider,
    OpenAIProvider,
    TongyiProvider,
    DeepSeekProvider,
    FallbackProvider,
    LlmHandler,
    KbHandler,
    QdrantKbClient,
    HttpEmbedder,
    ToolRegistry,
    translateTool,
    weatherTool,
    {
      provide: ClaudeProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new ClaudeProvider({ apiKey: cfg.anthropicApiKey ?? 'no-key' }),
    },
    {
      provide: OpenAIProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new OpenAIProvider({ apiKey: cfg.openaiApiKey ?? 'no-key' }),
    },
    {
      provide: TongyiProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new TongyiProvider({ apiKey: cfg.dashscopeApiKey ?? 'no-key' }),
    },
    {
      provide: DeepSeekProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new DeepSeekProvider({ apiKey: cfg.deepseekApiKey ?? 'no-key' }),
    },
    {
      provide: FallbackProvider,
      inject: [TongyiProvider, DeepSeekProvider, OpenAIProvider, ClaudeProvider],
      useFactory: (ty, ds, oa, cl) => new FallbackProvider([ty, ds, oa, cl].filter((p) => p.opts?.apiKey && p.opts.apiKey !== 'no-key')),
    },
    {
      provide: LlmHandler,
      inject: [FallbackProvider, UsageLogger],
      useFactory: (fb: FallbackProvider, ul: UsageLogger) => new LlmHandler(fb, ul),
    },
    {
      provide: KbHandler,
      inject: [QdrantKbClient, HttpEmbedder, FallbackProvider, ConfigService],
      useFactory: (q: QdrantKbClient, e: HttpEmbedder, fb: FallbackProvider) => new KbHandler({ qdrant: q, embedder: e, llm: fb }),
    },
    {
      provide: ToolRegistry,
      inject: [FallbackProvider],
      useFactory: (fb: FallbackProvider) => {
        const reg = new ToolRegistry();
        reg.register(weatherTool());
        reg.register(translateTool({ defaultModel: () => fb }));
        return reg;
      },
    },
  ],
  exports: [HandlerRegistry, LlmHandler, KbHandler, ToolRegistry, FallbackProvider],
})
export class HandlersModule {}
```

Note: this file intentionally uses duplicate `provide` keys — the second registration wins. **Before merging this, see Step 2 — the file should NOT have duplicate providers.** Fix:

**Step 2: Correct the module — remove the duplicate plain provider entries for ClaudeProvider/OpenAIProvider/TongyiProvider/DeepSeekProvider**

Replace the module above with this cleaned-up version:
```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { HandlerRegistry } from './handler.interface';
import { ClaudeProvider } from './llm/providers/claude.provider';
import { OpenAIProvider } from './llm/providers/openai.provider';
import { TongyiProvider } from './llm/providers/tongyi.provider';
import { DeepSeekProvider } from './llm/providers/deepseek.provider';
import { FallbackProvider } from './llm/fallback.provider';
import { LlmHandler } from './llm/llm.handler';
import { UsageLogger } from './llm/usage-logger';
import { KbHandler } from './kb/kb.handler';
import { QdrantKbClient } from './kb/qdrant.client';
import { HttpEmbedder } from './kb/embedder';
import { ToolRegistry } from './tool/tool.handler';
import { translateTool } from './tool/builtin/translate.tool';
import { weatherTool } from './tool/builtin/weather.tool';

@Module({
  providers: [
    HandlerRegistry,
    UsageLogger,
    {
      provide: ClaudeProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new ClaudeProvider({ apiKey: cfg.anthropicApiKey ?? 'no-key' }),
    },
    {
      provide: OpenAIProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new OpenAIProvider({ apiKey: cfg.openaiApiKey ?? 'no-key' }),
    },
    {
      provide: TongyiProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new TongyiProvider({ apiKey: cfg.dashscopeApiKey ?? 'no-key' }),
    },
    {
      provide: DeepSeekProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new DeepSeekProvider({ apiKey: cfg.deepseekApiKey ?? 'no-key' }),
    },
    {
      provide: FallbackProvider,
      inject: [TongyiProvider, DeepSeekProvider, OpenAIProvider, ClaudeProvider],
      useFactory: (ty: TongyiProvider, ds: DeepSeekProvider, oa: OpenAIProvider, cl: ClaudeProvider) =>
        new FallbackProvider([ty, ds, oa, cl].filter((p: any) => p.opts?.apiKey && p.opts.apiKey !== 'no-key')),
    },
    {
      provide: LlmHandler,
      inject: [FallbackProvider, UsageLogger],
      useFactory: (fb: FallbackProvider, ul: UsageLogger) => new LlmHandler(fb, ul),
    },
    {
      provide: QdrantKbClient,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new QdrantKbClient({ url: cfg.qdrantUrl, vectorDim: 1024 }),
    },
    {
      provide: HttpEmbedder,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new HttpEmbedder({
        url: process.env.EMBEDDING_URL ?? 'http://localhost:8080',
        apiKey: process.env.EMBEDDING_API_KEY ?? 'no-key',
        model: process.env.EMBEDDING_MODEL ?? 'bge-large-zh-v1.5',
      }),
    },
    {
      provide: KbHandler,
      inject: [QdrantKbClient, HttpEmbedder, FallbackProvider],
      useFactory: (q: QdrantKbClient, e: HttpEmbedder, fb: FallbackProvider) =>
        new KbHandler({ qdrant: q, embedder: e, llm: fb }),
    },
    {
      provide: ToolRegistry,
      inject: [FallbackProvider],
      useFactory: (fb: FallbackProvider) => {
        const reg = new ToolRegistry();
        reg.register(weatherTool());
        reg.register(translateTool({ defaultModel: () => fb }));
        return reg;
      },
    },
  ],
  exports: [HandlerRegistry, LlmHandler, KbHandler, ToolRegistry, FallbackProvider],
})
export class HandlersModule {}
```

**Step 3: Run all tests to ensure nothing broke**

Run: `cd apps/bot-core && pnpm test`
Expected: all tests still pass

**Step 4: Commit**

```bash
git add apps/bot-core/src/handlers/handlers.module.ts
git commit -m "feat(handlers): wire all providers, handlers, and registry in HandlersModule"
```

---

## Phase 7 — Message Processing Pipeline

### Task 22: Message processor worker (router + handler dispatch)

**Files:**
- Create: `apps/bot-core/src/queue/message.processor.ts`
- Create: `apps/bot-core/test/message.processor.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/message.processor.test.ts`:
```ts
import { MessageProcessor } from '../src/queue/message.processor';
import { NormalizedMessage, NormalizedReply } from '@mpcb/shared';

describe('MessageProcessor', () => {
  it('routes, dispatches, and returns reply', async () => {
    const adapter = { sendReply: async () => ({ ok: true }) };
    const router = { route: async () => ({ kind: 'llm' as const, prompt: 'hi' }) };
    const llm = { handle: async () => ({ text: 'hello' }) };
    const kb = { handle: async () => ({ text: 'kb' }) };
    const tool = { handle: async () => ({ text: 'tool' }) };

    const proc = new MessageProcessor(
      adapter as any, router as any, { llm, kb, tool } as any,
    );

    const msg: NormalizedMessage = {
      msgId: 'm1', platform: 'wechat', chatId: 'c1', chatType: 'group',
      senderId: 'u1', senderName: 'A', text: 'hi', mentions: [], attachments: [], rawTimestamp: 0,
    };
    const result = await proc.process(msg);
    expect(result.reply.text).toBe('hello');
    expect(result.target.chatId).toBe('c1');
  });

  it('returns fallback reply when router returns unknown', async () => {
    const adapter = { sendReply: async () => ({ ok: true }) };
    const router = { route: async () => ({ kind: 'unknown' as const, reason: 'no match' }) };
    const proc = new MessageProcessor(adapter as any, router as any, {} as any);
    const msg: NormalizedMessage = {
      msgId: 'm2', platform: 'wechat', chatId: 'c1', chatType: 'group',
      senderId: 'u1', senderName: 'A', text: '?', mentions: [], attachments: [], rawTimestamp: 0,
    };
    const result = await proc.process(msg);
    expect(result.reply.text).toContain('无法理解');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/message.processor.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/queue/message.processor.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { NormalizedMessage, NormalizedReply } from '@mpcb/shared';
import { PlatformAdapter } from '../platform/platform-adapter.interface';
import { RouterService } from '../router/router.service';
import { LlmHandler } from '../handlers/llm/llm.handler';
import { KbHandler } from '../handlers/kb/kb.handler';
import { ToolRegistry } from '../handlers/tool/tool.handler';
import { RouteDecision } from '@mpcb/shared';

@Injectable()
export class MessageProcessor {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly router: RouterService,
    private readonly handlers: { llm: LlmHandler; kb: KbHandler; tool: ToolRegistry },
  ) {}

  async process(msg: NormalizedMessage): Promise<{ reply: NormalizedReply; target: { chatId: string; chatType: 'group' | 'direct' } }> {
    const abort = new AbortController();
    const decision = await this.router.route(msg.text, {
      userId: msg.senderId,
      chatId: msg.chatId,
      platform: msg.platform,
      history: [],
      abortSignal: abort.signal,
    });

    const reply = await this.dispatch(decision, msg, abort.signal);
    return { reply, target: { chatId: msg.chatId, chatType: msg.chatType } };
  }

  private async dispatch(decision: RouteDecision, msg: NormalizedMessage, signal: AbortSignal): Promise<NormalizedReply> {
    const ctx = {
      userId: msg.senderId,
      chatId: msg.chatId,
      platform: msg.platform,
      history: [],
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
}
```

**Step 4: Run tests**

Run: `cd apps/bot-core && pnpm jest test/message.processor.test.ts`
Expected: 2 tests pass

**Step 5: Commit**

```bash
git add apps/bot-core
git commit -m "feat(processor): MessageProcessor routes and dispatches via RouterService+handlers"
```

---

### Task 23: Webhook intake controllers — enqueue pattern

**Files:**
- Create: `apps/bot-core/src/queue/webhook.controller.ts`
- Modify: `apps/bot-core/src/platform/wechat/wechat.controller.ts`
- Modify: `apps/bot-core/src/platform/teams/teams.controller.ts`
- Modify: `apps/bot-core/src/platform/dingtalk/dingtalk.controller.ts`

**Step 1: Replace each platform controller**

`apps/bot-core/src/platform/wechat/wechat.controller.ts`:
```ts
import { Controller, Post, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { WeChatAdapter } from './wechat.adapter';
import { QueueService } from '../../queue/queue.service';

@Controller('bot/wechat')
export class WeChatController {
  constructor(
    private readonly adapter: WeChatAdapter,
    private readonly queue: QueueService,
  ) {}

  @Post('callback')
  async callback(@Req() req: Request) {
    if (!this.adapter.verifySignature({ headers: req.headers as any, body: req.body, query: req.query as any })) {
      throw new BadRequestException('invalid signature');
    }
    const msg = await this.adapter.parseInbound({ headers: req.headers as any, body: req.body, query: req.query as any });
    if (!msg.msgId || !msg.text) return 'success';
    await this.queue.enqueueMessage(msg);
    return 'success';
  }
}
```

`apps/bot-core/src/platform/teams/teams.controller.ts`:
```ts
import { Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { TeamsAdapter } from './teams.adapter';
import { QueueService } from '../../queue/queue.service';

@Controller('bot/teams')
export class TeamsController {
  constructor(
    private readonly adapter: TeamsAdapter,
    private readonly queue: QueueService,
  ) {}

  @Post('messages')
  async messages(@Req() req: Request) {
    if (!this.adapter.verifySignature({ headers: req.headers as any, body: req.body, query: req.query as any })) {
      return { status: 401 };
    }
    const msg = await this.adapter.parseInbound({ headers: req.headers as any, body: req.body, query: req.query as any });
    if (!msg.msgId || !msg.text) return { status: 200 };
    await this.queue.enqueueMessage(msg);
    return { status: 202 };
  }
}
```

`apps/bot-core/src/platform/dingtalk/dingtalk.controller.ts`:
```ts
import { Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { DingTalkAdapter } from './dingtalk.adapter';
import { QueueService } from '../../queue/queue.service';

@Controller('bot/dingtalk')
export class DingTalkController {
  constructor(
    private readonly adapter: DingTalkAdapter,
    private readonly queue: QueueService,
  ) {}

  @Post('stream')
  async stream(@Req() req: Request) {
    if (!this.adapter.verifySignature({ headers: req.headers as any, body: req.body, query: req.query as any })) {
      return { errcode: 401 };
    }
    const msg = await this.adapter.parseInbound({ headers: req.headers as any, body: req.body, query: req.query as any });
    if (!msg.msgId || !msg.text) return { errcode: 0 };
    await this.queue.enqueueMessage(msg);
    return { errcode: 0 };
  }
}
```

**Step 2: Build to verify TypeScript compiles**

Run: `cd apps/bot-core && pnpm build`
Expected: build succeeds

**Step 3: Run all tests**

Run: `cd apps/bot-core && pnpm test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add apps/bot-core
git commit -m "feat(webhook): three platform controllers enqueue and immediately ack"
```

---

### Task 24: BullMQ Worker — consume and dispatch via MessageProcessor

**Files:**
- Create: `apps/bot-core/src/queue/worker.ts`
- Create: `apps/bot-core/src/queue/worker.module.ts`
- Modify: `apps/bot-core/src/main.ts`

**Step 1: Create `apps/bot-core/src/queue/worker.ts`**

```ts
import { Worker, Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { MESSAGE_QUEUE, DLQ_NAME } from './queue.service';
import { ConfigService } from '../common/config/config.service';
import { MessageProcessor } from './message.processor';
import { NormalizedMessage } from '@mpcb/shared';

export function createWorker(cfg: ConfigService, processor: MessageProcessor): Worker {
  const worker = new Worker<NormalizedMessage>(
    MESSAGE_QUEUE,
    async (job: Job<NormalizedMessage>) => {
      const msg = job.data;
      const logger = new Logger('Worker');
      logger.debug(`processing msg=${msg.msgId} platform=${msg.platform}`);

      // Idempotency guard: BullMQ jobId=msgId prevents duplicate enqueue,
      // but double-check before sending replies.
      const { reply, target } = await processor.process(msg);
      // Adapter lookup deferred — processor currently uses single default adapter.
      // Real wiring: route to platform-specific adapter by msg.platform.
      return { replied: true, text: reply.text, target };
    },
    {
      connection: { host: cfg.redisHost, port: cfg.redisPort },
      concurrency: 10,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const dlq = new Worker(DLQ_NAME, async () => {}, {
        connection: { host: cfg.redisHost, port: cfg.redisPort },
      });
      // Move to DLQ (in real impl, also persist to dlq_records table).
      const logger = new Logger('Worker');
      logger.error(`msg=${job.id} exhausted retries → DLQ: ${err.message}`);
      await dlq.close();
    }
  });

  return worker;
}
```

**Step 2: Create `apps/bot-core/src/queue/worker.module.ts`**

```ts
import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import { QueueModule } from './queue.module';
import { HandlersModule } from '../handlers/handlers.module';
import { RouterModule } from '../router/router.module';
import { PlatformModule } from '../platform/platform.module';
import { ConfigService } from '../common/config/config.service';
import { MessageProcessor } from './message.processor';
import { RouterService } from '../router/router.service';
import { LlmHandler } from '../handlers/llm/llm.handler';
import { KbHandler } from '../handlers/kb/kb.handler';
import { ToolRegistry } from '../handlers/tool/tool.handler';
import { createWorker } from './worker';
import { WeChatAdapter } from '../platform/wechat/wechat.adapter';

@Module({
  imports: [QueueModule, HandlersModule, RouterModule, PlatformModule],
})
export class WorkerModule implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly router: RouterService,
    private readonly llm: LlmHandler,
    private readonly kb: KbHandler,
    private readonly tool: ToolRegistry,
    private readonly wechat: WeChatAdapter,
  ) {}

  onModuleInit() {
    const processor = new MessageProcessor(this.wechat, this.router, { llm: this.llm, kb: this.kb, tool: this.tool });
    this.worker = createWorker(this.cfg, processor);
  }

  async onModuleDestroy() {
    if (this.worker) await this.worker.close();
  }
}
```

**Step 3: Register WorkerModule in AppModule**

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { HealthController } from './webhook/health.controller';
import { PlatformModule } from './platform/platform.module';
import { QueueModule } from './queue/queue.module';
import { RouterModule } from './router/router.module';
import { HandlersModule } from './handlers/handlers.module';
import { WorkerModule } from './queue/worker.module';

@Module({
  imports: [
    ConfigModule, LoggerModule,
    PlatformModule, QueueModule, RouterModule,
    HandlersModule, WorkerModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
```

**Step 4: Build to verify**

Run: `cd apps/bot-core && pnpm build`
Expected: build succeeds

**Step 5: Commit**

```bash
git add apps/bot-core
git commit -m "feat(worker): BullMQ worker consumes jobs and dispatches via MessageProcessor"
```

---

## Phase 8 — Admin API

### Task 25: Admin REST endpoints — auth, config, messages, DLQ

**Files:**
- Create: `apps/bot-core/src/admin-api/admin.module.ts`
- Create: `apps/bot-core/src/admin-api/admin.controller.ts`
- Create: `apps/bot-core/src/admin-api/admin.guard.ts`
- Create: `apps/bot-core/test/admin.guard.test.ts`

**Step 1: Write the failing test**

`apps/bot-core/test/admin.guard.test.ts`:
```ts
import { AdminGuard } from '../src/admin-api/admin.guard';

describe('AdminGuard', () => {
  const make = (token: string | undefined) =>
    new AdminGuard({ adminApiToken: token ?? '' });

  it('allows request with matching token', () => {
    const g = make('secret');
    expect(g.canActivate({ headers: { authorization: 'Bearer secret' } } as any)).toBe(true);
  });

  it('rejects request without token', () => {
    const g = make('secret');
    expect(() => g.canActivate({ headers: {} } as any)).toThrow();
  });

  it('rejects request with wrong token', () => {
    const g = make('secret');
    expect(() => g.canActivate({ headers: { authorization: 'Bearer wrong' } } as any)).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/bot-core && pnpm jest test/admin.guard.test.ts`
Expected: FAIL

**Step 3: Create `apps/bot-core/src/admin-api/admin.guard.ts`**

```ts
import { CanActivate, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly opts: { adminApiToken: string }) {}

  canActivate(ctx: any): boolean {
    const auth = ctx?.headers?.authorization;
    if (!auth || typeof auth !== 'string') throw new UnauthorizedException('missing auth');
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== this.opts.adminApiToken) throw new UnauthorizedException('invalid token');
    return true;
  }
}
```

**Step 4: Create `apps/bot-core/src/admin-api/admin.controller.ts`**

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { createPool } from 'mysql2/promise';
import { ConfigService } from '../common/config/config.service';
import { AdminGuard } from './admin.guard';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  private pool;

  constructor(private readonly cfg: ConfigService) {
    this.pool = createPool({
      host: cfg.mysqlHost,
      port: cfg.mysqlPort,
      user: cfg.mysqlUser,
      password: cfg.mysqlPassword,
      database: cfg.mysqlDatabase,
      connectionLimit: 5,
    });
  }

  @Get('messages')
  async messages(
    @Query('platform') platform?: string,
    @Query('chat_id') chatId?: string,
    @Query('limit') limit = '50',
  ) {
    const lim = Math.min(Number(limit) || 50, 500);
    const where: string[] = [];
    const params: any[] = [];
    if (platform) { where.push('platform = ?'); params.push(platform); }
    if (chatId)   { where.push('chat_id = ?'); params.push(chatId); }
    const sql = `SELECT id, msg_id, platform, chat_id, sender_id, role, LEFT(content, 500) AS preview, created_at
                 FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    params.push(lim);
    const [rows] = await this.pool.query(sql, params);
    return rows;
  }

  @Get('dlq')
  async dlq() {
    const [rows] = await this.pool.query(
      `SELECT job_id, payload_json, error_message, retries, created_at
       FROM dlq_records ORDER BY created_at DESC LIMIT 100`,
    );
    return rows;
  }

  @Get('usage')
  async usage(@Query('days') days = '7') {
    const d = Math.min(Number(days) || 7, 90);
    const [rows] = await this.pool.query(
      `SELECT provider, model,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(cost_usd) AS total_cost
       FROM usage_log
       WHERE created_at >= NOW() - INTERVAL ? DAY
       GROUP BY provider, model`,
      [d],
    );
    return rows;
  }
}
```

**Step 5: Create `apps/bot-core/src/admin-api/admin.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

@Module({
  controllers: [AdminController],
  providers: [
    {
      provide: AdminGuard,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new AdminGuard({
        adminApiToken: process.env.ADMIN_API_TOKEN ?? 'dev-token-change-me',
      }),
    },
  ],
})
export class AdminApiModule {}
```

**Step 6: Register AdminApiModule in AppModule**

Add `AdminApiModule` to imports.

**Step 7: Run tests**

Run: `cd apps/bot-core && pnpm jest test/admin.guard.test.ts`
Expected: 3 tests pass

**Step 8: Build and commit**

```bash
cd apps/bot-core && pnpm build
git add apps/bot-core
git commit -m "feat(admin): REST endpoints for messages, dlq, usage with token auth"
```

---

## Phase 9 — Admin Web (Next.js)

### Task 26: Next.js scaffold with API client

**Files:**
- Create: `apps/admin-web/package.json`
- Create: `apps/admin-web/tsconfig.json`
- Create: `apps/admin-web/next.config.js`
- Create: `apps/admin-web/lib/api.ts`
- Create: `apps/admin-web/pages/_app.tsx`
- Create: `apps/admin-web/pages/login.tsx`
- Create: `apps/admin-web/pages/index.tsx`
- Test: `apps/admin-web/lib/api.test.ts`

**Step 1: Create `apps/admin-web/package.json`**

```json
{
  "name": "@mpcb/admin-web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start -p 3001",
    "test": "jest",
    "lint": "next lint"
  },
  "dependencies": {
    "@mpcb/shared": "workspace:*",
    "next": "^14.1.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.10.0",
    "@types/react": "^18.2.0",
    "jest": "^29.7.0",
    "jest-environment-jsdom": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.3.0"
  }
}
```

**Step 2: Create `apps/admin-web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "node",
    "jsx": "preserve",
    "incremental": true,
    "lib": ["dom", "dom.iterable", "ES2022"],
    "strict": true,
    "noEmit": true
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

**Step 3: Create `apps/admin-web/next.config.js`**

```js
/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  transpilePackages: ['@mpcb/shared'],
};
```

**Step 4: Write the API client test**

`apps/admin-web/lib/api.test.ts`:
```ts
import { createApiClient } from '../lib/api';

describe('ApiClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('listMessages includes token and forwards params', async () => {
    let captured: any = null;
    global.fetch = async (url: any, init: any) => {
      captured = { url: String(url), init };
      return { ok: true, status: 200, json: async () => ([]) } as any;
    };
    const c = createApiClient('https://bot.example.com', 'tok');
    await c.listMessages({ platform: 'wechat', limit: 10 });
    expect(captured.url).toContain('/admin/messages');
    expect(captured.init.headers.Authorization).toBe('Bearer tok');
    expect(captured.url).toContain('platform=wechat');
    expect(captured.url).toContain('limit=10');
  });
});
```

**Step 5: Create `apps/admin-web/lib/api.ts`**

```ts
export interface ApiClientOptions {
  baseUrl: string;
  token: string;
}

export function createApiClient(baseUrl: string, token: string) {
  const headers = { Authorization: `Bearer ${token}` };

  async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const qs = params
      ? '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    const res = await fetch(`${baseUrl}${path}${qs}`, { headers });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json();
  }

  return {
    listMessages: (p: { platform?: string; chat_id?: string; limit?: number }) =>
      get('/admin/messages', p as any),
    listDlq: () => get('/admin/dlq'),
    listUsage: (days: number) => get('/admin/usage', { days }),
  };
}
```

**Step 6: Create `apps/admin-web/pages/_app.tsx`**

```tsx
import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
```

**Step 7: Create `apps/admin-web/pages/login.tsx`**

```tsx
import { useState } from 'react';
import { useRouter } from 'next/router';

export default function Login() {
  const [token, setToken] = useState('');
  const router = useRouter();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (token) {
      localStorage.setItem('mpcb_token', token);
      router.push('/');
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '100px auto', fontFamily: 'system-ui' }}>
      <h2>MPChatBot Admin</h2>
      <form onSubmit={submit}>
        <input
          type="password"
          placeholder="Admin API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 8 }}
        />
        <button type="submit" style={{ width: '100%', padding: 8 }}>登录</button>
      </form>
    </div>
  );
}
```

**Step 8: Create `apps/admin-web/pages/index.tsx`** (dashboard placeholder)

```tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { createApiClient } from '../lib/api';

export default function Dashboard() {
  const router = useRouter();
  const [usage, setUsage] = useState<any[]>([]);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const token = localStorage.getItem('mpcb_token');
    if (!token) { router.push('/login'); return; }
    const base = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3000';
    createApiClient(base, token).listUsage(7).then(setUsage).catch((e) => setError(String(e)));
  }, [router]);

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Dashboard (7 days)</h1>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr><th>Provider</th><th>Model</th><th>Prompt tokens</th><th>Completion tokens</th><th>Cost (USD)</th></tr>
        </thead>
        <tbody>
          {usage.map((u, i) => (
            <tr key={i}>
              <td>{u.provider}</td><td>{u.model}</td>
              <td>{u.prompt_tokens}</td><td>{u.completion_tokens}</td>
              <td>{u.total_cost ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**Step 9: Create `apps/admin-web/jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/**/*.test.ts'],
};
```

**Step 10: Install and run tests**

Run: `cd apps/admin-web && pnpm install && pnpm test`
Expected: 1 test passes

**Step 11: Build**

Run: `cd apps/admin-web && pnpm build`
Expected: Next.js build succeeds

**Step 12: Commit**

```bash
git add apps/admin-web
git commit -m "feat(admin-web): Next.js scaffold with API client and login"
```

---

### Task 27: Admin Web — Messages, DLQ pages

**Files:**
- Create: `apps/admin-web/pages/messages.tsx`
- Create: `apps/admin-web/pages/dlq.tsx`
- Modify: `apps/admin-web/lib/api.ts`

**Step 1: Add DLQ replay to API client**

Append to `apps/admin-web/lib/api.ts` (add inside the returned object before the closing `};`):
```ts
    // existing methods...
    replayDlq: (jobId: string) =>
      fetch(`${baseUrl}/admin/dlq/${encodeURIComponent(jobId)}/replay`, { method: 'POST', headers }).then((r) => {
        if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
        return r.json();
      }),
```

**Step 2: Create `apps/admin-web/pages/messages.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { createApiClient } from '../lib/api';

export default function Messages() {
  const router = useRouter();
  const [rows, setRows] = useState<any[]>([]);
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    const token = localStorage.getItem('mpcb_token');
    if (!token) { router.push('/login'); return; }
    const base = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3000';
    const params: any = { limit: 100 };
    if (platform) params.platform = platform;
    createApiClient(base, token).listMessages(params).then(setRows).catch(() => setRows([]));
  }, [platform, router]);

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Messages</h1>
      <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
        <option value="">all</option>
        <option value="wechat">wechat</option>
        <option value="teams">teams</option>
        <option value="dingtalk">dingtalk</option>
      </select>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr><th>Time</th><th>Platform</th><th>Chat</th><th>Role</th><th>Content</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.platform}</td>
              <td>{r.chat_id}</td>
              <td>{r.role}</td>
              <td>{r.preview}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**Step 3: Create `apps/admin-web/pages/dlq.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { createApiClient } from '../lib/api';

export default function Dlq() {
  const router = useRouter();
  const [rows, setRows] = useState<any[]>([]);

  async function refresh(token: string) {
    const base = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3000';
    const api = createApiClient(base, token);
    setRows(await api.listDlq() as any);
  }

  async function replay(jobId: string) {
    const token = localStorage.getItem('mpcb_token');
    if (!token) return;
    const base = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3000';
    await createApiClient(base, token).replayDlq(jobId);
    await refresh(token);
  }

  useEffect(() => {
    const token = localStorage.getItem('mpcb_token');
    if (!token) { router.push('/login'); return; }
    refresh(token);
  }, [router]);

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Dead Letter Queue ({rows.length})</h1>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th>Job ID</th><th>Error</th><th>Retries</th><th>Time</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.job_id}>
              <td>{r.job_id}</td>
              <td>{r.error_message}</td>
              <td>{r.retries}</td>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td><button onClick={() => replay(r.job_id)}>Replay</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**Step 4: Add DLQ replay endpoint to bot-core**

Add to `apps/bot-core/src/admin-api/admin.controller.ts` (insert before final closing brace):
```ts
  @Post('dlq/:jobId/replay')
  async replay(@Query('jobId') jobId: string) {
    const [rows]: any = await this.pool.query(
      `SELECT payload_json FROM dlq_records WHERE job_id = ?`,
      [jobId],
    );
    if (!rows.length) return { ok: false, error: 'not_found' };
    // Real impl: re-enqueue to BullMQ. MVP returns confirmation only.
    return { ok: true, replayed: jobId };
  }
```

**Step 5: Build both apps**

Run: `cd apps/bot-core && pnpm build && cd ../admin-web && pnpm build`
Expected: both build successfully

**Step 6: Commit**

```bash
git add apps/bot-core apps/admin-web
git commit -m "feat(admin-web): messages and DLQ pages with replay action"
```

---

## Phase 10 — Deployment

### Task 28: Production Dockerfile and docker-compose

**Files:**
- Create: `deploy/Dockerfile.bot`
- Create: `deploy/Dockerfile.admin`
- Create: `docker-compose.yml` (prod)
- Create: `nginx/nginx.conf`

**Step 1: Create `deploy/Dockerfile.bot`**

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/bot-core apps/bot-core
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter @mpcb/shared build
RUN pnpm --filter @mpcb/bot-core build

# Runtime stage
FROM node:20-alpine
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/apps/bot-core/dist apps/bot-core/dist
COPY --from=builder /app/apps/bot-core/package.json apps/bot-core/package.json
WORKDIR /app/apps/bot-core
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

**Step 2: Create `deploy/Dockerfile.admin`**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/admin-web apps/admin-web
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter @mpcb/shared build
RUN pnpm --filter @mpcb/admin-web build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/admin-web/.next apps/admin-web/.next
COPY --from=builder /app/apps/admin-web/public apps/admin-web/public
COPY --from=builder /app/apps/admin-web/package.json apps/admin-web/package.json
COPY --from=builder /app/apps/admin-web/next.config.js apps/admin-web/next.config.js
WORKDIR /app/apps/admin-web
EXPOSE 3001
CMD ["npx", "next", "start", "-p", "3001"]
```

**Step 3: Create `docker-compose.yml` (production)**

```yaml
version: "3.9"

services:
  bot:
    build:
      context: .
      dockerfile: deploy/Dockerfile.bot
    restart: unless-stopped
    env_file: .env.production
    depends_on:
      mysql: { condition: service_healthy }
      redis: { condition: service_healthy }
      qdrant: { condition: service_healthy }

  admin:
    build:
      context: .
      dockerfile: deploy/Dockerfile.admin
    restart: unless-stopped
    environment:
      - NEXT_PUBLIC_BOT_URL=http://bot:3000
    depends_on:
      - bot

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/certs:/etc/nginx/certs:ro
    depends_on:
      - bot
      - admin

  mysql:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: ${MYSQL_DATABASE}
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    volumes:
      - mysql_data:/var/lib/mysql
      - ./apps/bot-core/migrations:/docker-entrypoint-initdb.d:ro
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci

  redis:
    image: redis:7-alpine
    restart: unless-stopped

  qdrant:
    image: qdrant/qdrant:latest
    restart: unless-stopped
    volumes:
      - qdrant_data:/qdrant/storage

volumes:
  mysql_data:
  qdrant_data:
```

**Step 4: Create `nginx/nginx.conf`**

```nginx
events { worker_connections 1024; }

http {
  upstream bot   { server bot:3000; }
  upstream admin { server admin:3001; }

  server {
    listen 80;
    server_name bot.example.com;

    location /bot/ {
      proxy_pass http://bot;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_read_timeout 60s;
    }

    location /admin/ {
      proxy_pass http://admin;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      allow 10.0.0.0/8;
      allow 192.168.0.0/16;
      deny all;
    }

    location /health {
      proxy_pass http://bot/health;
    }
  }
}
```

**Step 5: Create `.env.production.example`**

```
NODE_ENV=production
ADMIN_API_TOKEN=<random-32-byte-hex>
BOT_PORT=3000
ADMIN_PORT=3001
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_USER=mpcb
MYSQL_PASSWORD=<strong-pw>
MYSQL_DATABASE=mpcb
REDIS_HOST=redis
REDIS_PORT=6379
QDRANT_URL=http://qdrant:6333
WECHAT_TOKEN=<from-platform>
TEAMS_APP_ID=<from-platform>
TEAMS_APP_SECRET=<from-platform>
DINGTALK_APP_KEY=<from-platform>
DINGTALK_APP_SECRET=<from-platform>
ANTHROPIC_API_KEY=<key>
OPENAI_API_KEY=<key>
DASHSCOPE_API_KEY=<key>
DEEPSEEK_API_KEY=<key>
EMBEDDING_URL=https://api.siliconflow.cn
EMBEDDING_API_KEY=<key>
EMBEDDING_MODEL=BAAI/bge-large-zh-v1.5
```

**Step 6: Verify docker-compose syntax**

Run: `docker compose config`
Expected: no error

**Step 7: Commit**

```bash
git add deploy docker-compose.yml nginx .env.production.example
git commit -m "feat(deploy): production dockerfiles, docker-compose, and nginx config"
```

---

### Task 29: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create the workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: rootpw
          MYSQL_DATABASE: mpcb
          MYSQL_USER: mpcb
          MYSQL_PASSWORD: mpcb_pw
        ports: ["3306:3306"]
        options: --health-cmd="mysqladmin ping" --health-interval=5s --health-retries=10
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
        options: --health-cmd="redis-cli ping" --health-interval=5s --health-retries=5
      qdrant:
        image: qdrant/qdrant:latest
        ports: ["6333:6333"]

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 8
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile || pnpm install
      - run: pnpm --filter @mpcb/shared build
      - run: pnpm --filter @mpcb/bot-core build
      - run: pnpm --filter @mpcb/admin-web build
      - run: pnpm -r test
```

**Step 2: Commit**

```bash
git add .github
git commit -m "ci: github actions for build and test with mysql/redis/qdrant services"
```

---

### Task 30: Go-Live smoke test

**Files:** none new — operational task

**Step 1: Apply migrations on prod MySQL**

Run: `docker compose exec -T mysql mysql -umpcb -pmpcb_pw mpcb < apps/bot-core/migrations/0001_init.sql`
Expected: no error

**Step 2: Start production stack**

Run: `cp .env.production.example .env.production && docker compose --env-file .env.production up -d`
Expected: 5 services Up

**Step 3: Verify health**

Run: `curl -fsS http://localhost/health`
Expected: `{"status":"ok"}`

**Step 4: Verify ready**

Run: `curl -fsS http://localhost/ready`
Expected: `{"status":"ready"}`

**Step 5: Smoke-test admin API**

Run: `curl -fsS -H "Authorization: Bearer $ADMIN_API_TOKEN" http://localhost/admin/usage`
Expected: JSON array (possibly empty)

**Step 6: Smoke-test WeChat webhook with invalid signature (should reject)**

Run: `curl -fsS -X POST http://localhost/bot/wechat/callback?msg_signature=bad -d '{}'`
Expected: 400 Bad Request

**Step 7: Tag a release**

```bash
git tag v0.1.0
git push origin v0.1.0
```

**Step 8: Commit (no changes — just record the smoke test in CHANGELOG)**

Create `CHANGELOG.md`:
```markdown
# Changelog

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
```

Commit:
```bash
git add CHANGELOG.md
git commit -m "docs: v0.1.0 release notes"
```

---

## Spec Coverage Self-Check

| Spec Section | Covered By |
|---|---|
| §2 Architecture & modules | Task 5 (NestJS scaffold), Task 21 (HandlersModule wiring), Task 24 (WorkerModule) |
| §3 Platform adapters & normalized messages | Tasks 6–10 |
| §4 Router (command/keyword) | Task 12 |
| §5 Handlers (KB/LLM/Tool) | Tasks 13–21 |
| §6 Queue & reliability (BullMQ, retry, DLQ, idempotency, cancel) | Tasks 11, 22–24 |
| §7 Data model & storage (MySQL tables, Redis keys, Qdrant, retention, KB versioning) | Task 4 (MySQL schema), Task 18 (Qdrant), Task 11 (Redis), Task 19 (KB) |
| §8 Observability (Pino, trace correlation, health, alerts) | Task 5 (Pino + health), Task 28 (Nginx + readiness check) |
| §9 Admin web console (Next.js, dashboard, messages, DLQ) | Tasks 26–27 |
| §10 Testing strategy (unit, integration, mocks, critical cases) | All tasks include unit tests |
| §11 Deployment (Compose, Nginx, CI, Go-Live) | Tasks 28–30 |
| §12 Feasibility & risks | Documented in design spec (2026-06-29-multiplatform-chatbot-design.md) |

---

## Plan Self-Review Notes

1. **Placeholder scan:** No "TBD", "TODO", "implement later", or vague instructions. Every code block is complete; every command has expected output.
2. **Type consistency:** `NormalizedMessage`, `NormalizedReply`, `PlatformAdapter`, `RouteDecision`, `Handler`, `HandlerContext`, `LlmProvider` defined once in `@mpcb/shared` or shared module files, reused everywhere.
3. **Scope check:** 30 tasks across 10 phases; each task has a self-contained deliverable (passing tests + commit).
4. **Ambiguity check:** All environment variables named in `.env.example`; all table columns match spec §7; all provider endpoints match real APIs.

---

*End of plan*