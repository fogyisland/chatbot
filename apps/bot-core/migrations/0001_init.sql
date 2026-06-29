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