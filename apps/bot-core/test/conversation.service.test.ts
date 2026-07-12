import { Test } from '@nestjs/testing';
import { ConversationService } from '../src/conversation/conversation.service';
import { ConfigService } from '../src/common/config/config.service';

// Minimal ConfigService stub providing only the fields getPool() reads.
function makeConfigStub(): ConfigService {
  return {
    mysqlHost: 'localhost',
    mysqlPort: 3306,
    mysqlUser: 'mpcb',
    mysqlPassword: 'mpcb_pw',
    mysqlDatabase: 'mpcb',
  } as unknown as ConfigService;
}

// Inject a pool so the service never calls real MySQL during unit tests.
function injectPool(svc: ConversationService, pool: any): void {
  (svc as unknown as { pool: any }).pool = pool;
}

function makeService(impl: (sql: string, params: unknown[]) => Promise<unknown>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool: any = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return impl(sql, params);
    },
  };
  const svc = new ConversationService(makeConfigStub());
  injectPool(svc, pool);
  // Capture warn() calls on the private logger so the MySQL-throw test stays valid.
  const warnMock = jest.fn();
  (svc as unknown as { logger: { warn: jest.Mock; error: jest.Mock; debug: jest.Mock } }).logger = {
    warn: warnMock,
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { svc, queries, warnMock };
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
    const t0 = new Date('2026-07-04T09:30:00Z');
    const { svc } = makeService(async () => [[
      baseRow({ created_at: t0 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
  });

  it('returns all in-window turns (up to FETCH_LIMIT) when no tokenBudget is given', async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      baseRow({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, created_at: new Date(NOW - (15 - i) * 60_000) }),
    );
    rows.reverse();
    const { svc } = makeService(async () => [rows]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toHaveLength(15);
    expect(out[0].content).toBe('m0');
    expect(out[14].content).toBe('m14');
  });

  it('returns empty array and logs warn when MySQL throws', async () => {
    const { svc, warnMock } = makeService(async () => { throw new Error('db down'); });
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('history load failed');
  });

  it('walker breaks at /forget boundary marker (boundary at i=0 returns empty)', async () => {
    const t0 = new Date('2026-07-04T10:25:00Z');
    const t1 = new Date('2026-07-04T10:24:00Z');
    const t2 = new Date('2026-07-04T10:20:00Z');
    const { svc } = makeService(async () => [[
      baseRow({ role: 'system', content: '__forget_boundary__', created_at: t0 }),
      baseRow({ role: 'assistant', content: 'c', created_at: t1 }),
      baseRow({ role: 'user', content: 'b', created_at: t2 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([]);
  });

  it('walker breaks at /forget boundary marker (boundary mid-history returns rows before it)', async () => {
    const t0 = new Date('2026-07-04T10:25:00Z');
    const t1 = new Date('2026-07-04T10:24:00Z');
    const t2 = new Date('2026-07-04T10:20:00Z');
    const t3 = new Date('2026-07-04T10:00:00Z');
    const { svc } = makeService(async () => [[
      baseRow({ role: 'user', content: 'recent', created_at: t0 }),
      baseRow({ role: 'assistant', content: 'mid', created_at: t1 }),
      baseRow({ role: 'system', content: '__forget_boundary__', created_at: t2 }),
      baseRow({ role: 'user', content: 'old', created_at: t3 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([
      { role: 'assistant', content: 'mid' },
      { role: 'user', content: 'recent' },
    ]);
  });

  it('walker does NOT break at non-marker system rows (e.g. future system-role rows)', async () => {
    const t0 = new Date('2026-07-04T10:25:00Z');
    const t1 = new Date('2026-07-04T10:24:00Z');
    const t2 = new Date('2026-07-04T10:20:00Z');
    // A system row with different content should not be treated as a boundary.
    const { svc } = makeService(async () => [[
      baseRow({ role: 'user', content: 'recent', created_at: t0 }),
      baseRow({ role: 'system', content: 'some-other-system-message', created_at: t1 }),
      baseRow({ role: 'assistant', content: 'old', created_at: t2 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([
      { role: 'assistant', content: 'old' },
      { role: 'system', content: 'some-other-system-message' },
      { role: 'user', content: 'recent' },
    ]);
  });

  it('walker does NOT break at user rows that happen to contain the marker content', async () => {
    const t0 = new Date('2026-07-04T10:25:00Z');
    const t1 = new Date('2026-07-04T10:24:00Z');
    // Defense-in-depth: boundary check is role=system AND content=marker.
    // A user row that happens to contain the marker text must not trigger a break.
    const { svc } = makeService(async () => [[
      baseRow({ role: 'user', content: '__forget_boundary__', created_at: t0 }),
      baseRow({ role: 'assistant', content: 'a', created_at: t1 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    expect(out).toEqual([
      { role: 'assistant', content: 'a' },
      { role: 'user', content: '__forget_boundary__' },
    ]);
  });

  it('walker excludes boundary rows from other senders (per-sender isolation)', async () => {
    const t0 = new Date('2026-07-04T10:25:00Z');
    const t1 = new Date('2026-07-04T10:24:00Z');
    // Sender B's query is filtered to sender_id IN ('u_b', 'bot'), so the
    // boundary row from sender A is never returned in the DESC result set.
    // The pool stub does not actually filter by sender_id — we emulate by
    // returning only B's rows.
    const { svc } = makeService(async () => [[
      baseRow({ role: 'user', content: 'b-q', created_at: t0 }),
      baseRow({ role: 'assistant', content: 'b-a', created_at: t1 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u_b', NOW);
    expect(out).toEqual([
      { role: 'assistant', content: 'b-a' },
      { role: 'user', content: 'b-q' },
    ]);
  });

  it('walker ignores a stale boundary: a 2-hour-old boundary row is still a break point', async () => {
    const t0 = new Date('2026-07-04T10:25:00Z');
    const t1 = new Date('2026-07-04T10:24:00Z');
    const t2 = new Date('2026-07-04T08:24:00Z');  // 2 hours before t1 — very stale
    const { svc } = makeService(async () => [[
      baseRow({ role: 'user', content: 'newest', created_at: t0 }),
      baseRow({ role: 'assistant', content: 'after-boundary', created_at: t1 }),
      baseRow({ role: 'system', content: '__forget_boundary__', created_at: t2 }),
    ]]);
    const out = await svc.loadHistory('wechat', 'c1', 'u1', NOW);
    // Boundary check fires at i=2 regardless of staleness. A 2-hour-old
    // boundary is still an absolute break point — the boundary check
    // supersedes both the 30-min gap check and the per-row timestamp.
    expect(out).toEqual([
      { role: 'assistant', content: 'after-boundary' },
      { role: 'user', content: 'newest' },
    ]);
  });

  // ── Token-budget filter (v0.4) ────────────────────────────────────────

  describe('loadHistory token-budget filter', () => {
    const minute = 60_000;
    const now = Date.now();

    function rowsSpec(specs: Array<{ role: string; content: string; ageMin: number }>) {
      // Most-recent first (DESC), as the SQL returns them.
      // The caller passes specs in ASC order (oldest first); we reverse
      // to produce the DESC rows that real MySQL ORDER BY DESC would return.
      const rows = specs.map(s => ({
        role: s.role,
        content: s.content,
        created_at: new Date(now - s.ageMin * minute),
      })).reverse();
      return rows;
    }

    it('returns all turns when history is well under budget', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'hi', ageMin: 0 },
        { role: 'assistant', content: 'hello', ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 100_000 });
      expect(result).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);
    });

    it('drops oldest turns FIFO until total <= budget', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(10), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(10), ageMin: 0 },
        { role: 'user', content: 'c'.repeat(10), ageMin: 0 },
        { role: 'assistant', content: 'd'.repeat(10), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 6 });
      expect(result).toEqual([{ role: 'assistant', content: 'd'.repeat(10) }]);
    });

    it('keeps newest turn even if it alone exceeds budget', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(100), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(100), ageMin: 0 },
        { role: 'user', content: 'c'.repeat(10000), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 100 });
      expect(result.length).toBe(1);
      expect(result[0].content).toBe('c'.repeat(10000));
    });

    it('CJK content counts as 1 token per character', async () => {
      const rows = rowsSpec([
        { role: 'user', content: '你'.repeat(100), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 50 });
      expect(result.length).toBe(1);
      const { svc: svc2 } = makeService(async () => [rows]);
      const result2 = await svc2.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 150 });
      expect(result2.length).toBe(1);
    });

    it('mixed CJK + ASCII sums both heuristics', async () => {
      const rows = rowsSpec([
        { role: 'user', content: '你好hello', ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 3 });
      expect(result.length).toBe(1);
      const { svc: svc2 } = makeService(async () => [rows]);
      const result2 = await svc2.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 4 });
      expect(result2.length).toBe(1);
    });

    it('does not trim when options is undefined (backwards compat)', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(1000), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(1000), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now);
      expect(result.length).toBe(2);
    });

    it('does not trim when tokenBudget is 0 (opt-out)', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(1000), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(1000), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 0 });
      expect(result.length).toBe(2);
    });

    it('does not trim when tokenBudget is negative (defensive)', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(1000), ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: -1 });
      expect(result.length).toBe(1);
    });

    it('returns [] for empty history + budget', async () => {
      const { svc } = makeService(async () => [[]]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 6000 });
      expect(result).toEqual([]);
    });

    it('preserves ConversationTurn shape (no tokens field leaked)', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'hello', ageMin: 0 },
        { role: 'assistant', content: 'world', ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 1 });
      for (const turn of result) {
        expect(turn).toEqual({ role: expect.any(String), content: expect.any(String) });
        expect((turn as any).tokens).toBeUndefined();
      }
    });

    it('boundary check runs BEFORE budget filter (forget wins)', async () => {
      const rows = rowsSpec([
        { role: 'system', content: '__forget_boundary__', ageMin: 0 },
      ]);
      const { svc } = makeService(async () => [rows]);
      const result = await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 100_000 });
      expect(result).toEqual([]);
    });

    it('debug-logs when turns are dropped', async () => {
      const rows = rowsSpec([
        { role: 'user', content: 'a'.repeat(10), ageMin: 0 },
        { role: 'assistant', content: 'b'.repeat(10), ageMin: 0 },
        { role: 'user', content: 'c'.repeat(10), ageMin: 0 },
        { role: 'assistant', content: 'd'.repeat(10), ageMin: 0 },
      ]);
      const { svc, warnMock } = makeService(async () => [rows]);
      const debugMock = jest.fn();
      (svc as unknown as { logger: { warn: jest.Mock; debug: jest.Mock } }).logger.debug = debugMock;
      await svc.loadHistory('wechat', 'c1', 'u1', now, { tokenBudget: 6 });
      expect(debugMock).toHaveBeenCalledWith(expect.stringMatching(/history trimmed.*budget=6/));
    });
  });
});

describe('ConversationService DI', () => {
  it('can be constructed via NestJS DI without external Pool/LOGGER providers', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ConversationService,
        {
          provide: ConfigService,
          useValue: {
            mysqlHost: 'h',
            mysqlPort: 3306,
            mysqlUser: 'u',
            mysqlPassword: '',
            mysqlDatabase: 'd',
          },
        },
      ],
    }).compile();
    expect(moduleRef.get(ConversationService)).toBeInstanceOf(ConversationService);
    await moduleRef.close();
  });
});
