import { ConversationService } from '../src/conversation/conversation.service';

function makeService(impl: (sql: string, params: unknown[]) => Promise<unknown>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool: any = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return impl(sql, params);
    },
  };
  const logger: any = { warn: jest.fn(), error: jest.fn() };
  const svc = new ConversationService(pool, logger);
  return { svc, queries, logger };
}

const baseRow = (over: Partial<{ role: string; content: string; created_at: Date }> = {}) => ({
  role: 'user',
  content: 'hi',
  created_at: new Date('2026-07-04T10:00:00Z'),
  ...over,
});

describe('ConversationService.loadHistory', () => {
  const NOW = new Date('2026-07-04T10:30:00Z').getTime();

  it('returns empty array when no rows', async () => {
    const { svc, queries } = makeService(async () => [[]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('FROM messages');
    expect(queries[0].sql).toContain('ORDER BY created_at DESC');
    expect(queries[0].sql).toContain('LIMIT');
    expect(queries[0].params).toEqual(['wechat', 'c1', 'u1', 'bot', 20]);
  });

  it('returns rows ascending when all within 30min window', async () => {
    const t0 = new Date('2026-07-04T10:00:00Z');
    const t1 = new Date('2026-07-04T10:05:00Z');
    const t2 = new Date('2026-07-04T10:10:00Z');
    // rows come DESC from MySQL
    const { svc } = makeService(async () => [[
      baseRow({ role: 'assistant', content: 'c', created_at: t2 }),
      baseRow({ role: 'user', content: 'b', created_at: t1 }),
      baseRow({ role: 'assistant', content: 'a', created_at: t0 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]);
  });

  it('breaks window at first turn older than 30min from its newer neighbor', async () => {
    // Walk DESC: newest is at t=10:25 (5min ago), then t=10:10 (15min from t=10:25),
    // then t=09:30 (40min from t=10:10) — break here.
    const t0 = new Date('2026-07-04T10:25:00Z');
    const t1 = new Date('2026-07-04T10:10:00Z');
    const t2 = new Date('2026-07-04T09:30:00Z');
    const { svc } = makeService(async () => [[
      baseRow({ role: 'user', content: 'recent', created_at: t0 }),
      baseRow({ role: 'assistant', content: 'mid', created_at: t1 }),
      baseRow({ role: 'user', content: 'old', created_at: t2 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([
      { role: 'assistant', content: 'mid' },
      { role: 'user', content: 'recent' },
    ]);
  });

  it('returns empty when most-recent row is older than 30min', async () => {
    const t0 = new Date('2026-07-04T09:30:00Z'); // 60min ago
    const { svc } = makeService(async () => [[
      baseRow({ created_at: t0 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
  });

  it('caps at HISTORY_LIMIT=10 turns', async () => {
    // 15 rows all within window. Expect 10.
    const rows = Array.from({ length: 15 }, (_, i) =>
      baseRow({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, created_at: new Date(NOW - (15 - i) * 60_000) }),
    );
    // ASC for clarity (DESC reordering is tested above); the service expects DESC input
    rows.reverse();
    const { svc } = makeService(async () => [rows]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ role: expect.stringMatching(/user|assistant/), content: expect.any(String) });
  });

  it('returns empty array and logs warn when MySQL throws', async () => {
    const { svc, logger } = makeService(async () => { throw new Error('db down'); });
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('history load failed');
  });
});
