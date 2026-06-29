// Mock bullmq at module load time so createWorker doesn't actually connect.
const fakeWorker: any = {
  _handlers: new Map<string, any>(),
  on(event: string, cb: any) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event)!.push(cb);
  },
  emit(event: string, ...args: any[]) {
    const list = this._handlers.get(event) ?? [];
    return Promise.all(list.map((cb: any) => cb(...args)));
  },
  async close() { /* noop */ },
};

jest.mock('bullmq', () => {
  return {
    Worker: jest.fn().mockImplementation(() => fakeWorker),
    Queue: jest.fn(),
    JobsOptions: {},
  };
});

import { createWorker } from '../src/queue/worker';
import { NormalizedMessage } from '@mpcb/shared';

describe('Worker DLQ persistence', () => {
  it('persists dlq_records row and enqueues DLQ job when attempts exhausted', async () => {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const dlqAdds: Array<{ name: string; data: any; opts: any }> = [];

    const fakePool: any = {
      query: async (sql: string, params: any[]) => {
        queries.push({ sql, params });
        return [[]];
      },
    };
    const fakeDlq: any = {
      add: async (name: string, data: any, opts: any) => {
        dlqAdds.push({ name, data, opts });
        return { id: 'dlq-1' };
      },
    };

    const cfg: any = {
      redisHost: 'localhost', redisPort: 6379,
      mysqlHost: 'h', mysqlPort: 3306, mysqlUser: 'u', mysqlPassword: 'p', mysqlDatabase: 'd',
    };
    const processor: any = {
      process: jest.fn(async () => ({
        reply: { text: 'hi' }, target: { chatId: 'c1', chatType: 'group' }, sent: true,
      })),
    };

    createWorker({ cfg, processor, dlq: fakeDlq, pool: fakePool });

    const msg: NormalizedMessage = {
      msgId: 'm1', platform: 'wechat', chatId: 'c1', chatType: 'group',
      senderId: 'u1', senderName: 'A', text: 'hi', mentions: [], attachments: [], rawTimestamp: 0,
    };
    const job = { id: 'm1', data: msg, attemptsMade: 3, opts: { attempts: 3 } };
    const err = new Error('boom');

    await fakeWorker.emit('failed', job, err);

    // Expect INSERT into dlq_records
    const dlqInsert = queries.find((q) => q.sql.includes('INSERT INTO dlq_records'));
    expect(dlqInsert).toBeDefined();
    expect(dlqInsert!.params[0]).toBe('m1');
    const payload = JSON.parse(dlqInsert!.params[1]);
    expect(payload).toMatchObject({ msgId: 'm1', platform: 'wechat' });
    expect(dlqInsert!.params[2]).toBe('boom');
    expect(dlqInsert!.params[3]).toBe(3);

    // Expect DLQ queue add
    expect(dlqAdds.length).toBe(1);
    expect(dlqAdds[0].name).toBe('message.dlq');
    expect(dlqAdds[0].data.jobId).toBe('m1');
    expect(dlqAdds[0].data.retries).toBe(3);
  });

  it('does NOT persist when attemptsMade < opts.attempts', async () => {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const fakePool: any = {
      query: async (sql: string, params: any[]) => {
        queries.push({ sql, params });
        return [[]];
      },
    };
    const fakeDlq: any = { add: async () => ({ id: 'dlq-x' }) };

    const cfg: any = {
      redisHost: 'localhost', redisPort: 6379,
      mysqlHost: 'h', mysqlPort: 3306, mysqlUser: 'u', mysqlPassword: 'p', mysqlDatabase: 'd',
    };
    const processor: any = { process: jest.fn() };
    createWorker({ cfg, processor, dlq: fakeDlq, pool: fakePool });

    const job = { id: 'm2', data: { msgId: 'm2' }, attemptsMade: 1, opts: { attempts: 3 } };
    await fakeWorker.emit('failed', job, new Error('first attempt'));

    const dlqInsert = queries.find((q) => q.sql.includes('INSERT INTO dlq_records'));
    expect(dlqInsert).toBeUndefined();
  });
});