import { MessageLogService } from '../src/messages/message-log.service';

describe('MessageLogService', () => {
  it('upsertUser issues INSERT … ON DUPLICATE KEY UPDATE on (platform, msg_id)', async () => {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const fakePool: any = {
      query: async (sql: string, params: any[]) => {
        queries.push({ sql, params });
        return [{ affectedRows: 1 }];
      },
    };

    // Bypass constructor pool creation by stubbing getPool via prototype? Simpler: rebuild via factory.
    // We use a Proxy on createPool through jest.mock is heavy. Instead: instantiate with cfg and replace internal pool.
    const cfg: any = { mysqlHost: 'h', mysqlPort: 3306, mysqlUser: 'u', mysqlPassword: 'p', mysqlDatabase: 'd' };
    const svc = new MessageLogService(cfg);
    // Override internal pool by exposing it via prototype. Use a small reflection trick:
    (svc as any).pool = fakePool;

    await svc.upsertUser({
      msgId: 'm1', platform: 'wechat', chatId: 'c1', chatType: 'group',
      senderId: 'u1', senderName: 'A', text: 'hi', mentions: [], attachments: [], rawTimestamp: 0,
    });

    expect(queries.length).toBe(1);
    const q = queries[0];
    expect(q.sql).toContain('INSERT INTO messages');
    expect(q.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(q.params).toEqual(['m1', 'wechat', 'c1', 'u1', 'hi']);
  });

  it('upsertAssistant issues INSERT … ON DUPLICATE KEY UPDATE with reply- msg_id', async () => {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const fakePool: any = {
      query: async (sql: string, params: any[]) => {
        queries.push({ sql, params });
        return [{ affectedRows: 1 }];
      },
    };
    const cfg: any = { mysqlHost: 'h', mysqlPort: 3306, mysqlUser: 'u', mysqlPassword: 'p', mysqlDatabase: 'd' };
    const svc = new MessageLogService(cfg);
    (svc as any).pool = fakePool;

    await svc.upsertAssistant({ text: 'assistant hi' }, 'm1', 'wechat', 'c1');

    expect(queries.length).toBe(1);
    const q = queries[0];
    expect(q.sql).toContain('INSERT INTO messages');
    expect(q.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(q.sql).toContain("'assistant'");
    expect(q.params[0]).toBe('reply-m1');
    expect(q.params[1]).toBe('wechat');
    expect(q.params[2]).toBe('c1');
    expect(q.params[3]).toBe('bot');
    expect(q.params[4]).toBe('assistant hi');
  });

  it('upsertUser swallows errors (does not throw)', async () => {
    const cfg: any = { mysqlHost: 'h', mysqlPort: 3306, mysqlUser: 'u', mysqlPassword: 'p', mysqlDatabase: 'd' };
    const svc = new MessageLogService(cfg);
    (svc as any).pool = { query: async () => { throw new Error('db down'); } };

    await expect(
      svc.upsertUser({
        msgId: 'm1', platform: 'wechat', chatId: 'c1', chatType: 'group',
        senderId: 'u1', senderName: 'A', text: 'hi', mentions: [], attachments: [], rawTimestamp: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('upsertUser no-ops on empty msgId', async () => {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const cfg: any = { mysqlHost: 'h', mysqlPort: 3306, mysqlUser: 'u', mysqlPassword: 'p', mysqlDatabase: 'd' };
    const svc = new MessageLogService(cfg);
    (svc as any).pool = { query: async (sql: string, params: any[]) => { queries.push({ sql, params }); return [{}]; } };

    await svc.upsertUser({
      msgId: '', platform: 'wechat', chatId: 'c1', chatType: 'group',
      senderId: 'u1', senderName: 'A', text: 'hi', mentions: [], attachments: [], rawTimestamp: 0,
    });
    expect(queries.length).toBe(0);
  });
});