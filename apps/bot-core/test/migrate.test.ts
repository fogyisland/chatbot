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

  it('contains 0003_messages_summary_role.sql', () => {
    const p = path.join(__dirname, '..', 'migrations', '0003_messages_summary_role.sql');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('0003 extends messages.role enum with summary', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '0003_messages_summary_role.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ALTER TABLE\s+messages\s+MODIFY/i);
    // Must extend enum to include 'summary'
    expect(sql).toMatch(/ENUM\([^)]*'summary'[^)]*\)/i);
    // Must NOT remove the existing values
    expect(sql).toMatch(/'user'/);
    expect(sql).toMatch(/'assistant'/);
    expect(sql).toMatch(/'system'/);
  });
});
