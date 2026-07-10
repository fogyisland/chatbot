-- Add composite index to support ConversationService.loadHistory()
-- which filters by (platform, chat_id, sender_id IN (?, ?)) and orders by created_at DESC.
-- The existing idx_messages_chat_time on (platform, chat_id, created_at) is broader
-- but still full-scans for sender_id; this index covers the exact query shape.

ALTER TABLE messages ADD KEY idx_messages_session (platform, chat_id, sender_id, created_at);