-- v0.6: extend messages.role enum to allow 'summary' rows.
-- MySQL 8 INSTANT DDL on enum extension — non-blocking on production tables.
-- Existing rows (which use only 'user', 'assistant', 'system') are preserved.
-- Reversible: ALTER TABLE messages MODIFY COLUMN role ENUM('user','assistant','system') NOT NULL;
ALTER TABLE messages
  MODIFY COLUMN role ENUM('user','assistant','system','summary') NOT NULL;
