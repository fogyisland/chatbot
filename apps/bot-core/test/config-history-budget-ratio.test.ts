import { ConfigService } from '../src/common/config/config.service';

const ORIGINAL_ENV = process.env.HISTORY_BUDGET_RATIO;

describe('ConfigService.historyBudgetRatio', () => {
  let svc: ConfigService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.HISTORY_BUDGET_RATIO;
    svc = new ConfigService();
    // NestJS Logger writes to console; spy and silence.
    warnSpy = jest.spyOn((svc as any).logger ?? console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.HISTORY_BUDGET_RATIO;
    else process.env.HISTORY_BUDGET_RATIO = ORIGINAL_ENV;
  });

  it('returns 0.5 when env is unset', () => {
    expect(svc.historyBudgetRatio).toBe(0.5);
  });

  it('returns the env value when valid (0 <= r <= 1)', () => {
    process.env.HISTORY_BUDGET_RATIO = '0.7';
    expect(svc.historyBudgetRatio).toBe(0.7);
  });

  it('returns 0 when env is exactly "0" (used as "disable" signal by spec §5)', () => {
    process.env.HISTORY_BUDGET_RATIO = '0';
    expect(svc.historyBudgetRatio).toBe(0);
  });

  it('falls back to 0.5 when env is negative', () => {
    process.env.HISTORY_BUDGET_RATIO = '-0.5';
    expect(svc.historyBudgetRatio).toBe(0.5);
  });

  it('falls back to 0.5 when env is greater than 1', () => {
    process.env.HISTORY_BUDGET_RATIO = '2';
    expect(svc.historyBudgetRatio).toBe(0.5);
  });

  it('falls back to 0.5 when env is unparseable', () => {
    process.env.HISTORY_BUDGET_RATIO = 'abc';
    expect(svc.historyBudgetRatio).toBe(0.5);
  });

  it('warns only once for repeated invalid env reads (warn-once flag)', () => {
    process.env.HISTORY_BUDGET_RATIO = 'invalid';
    // Re-init so the invalid env is observed after construction.
    svc = new ConfigService();
    warnSpy = jest.spyOn((svc as any).logger ?? console, 'warn').mockImplementation(() => {});

    // Read three times; warn should fire exactly once.
    expect(svc.historyBudgetRatio).toBe(0.5);
    expect(svc.historyBudgetRatio).toBe(0.5);
    expect(svc.historyBudgetRatio).toBe(0.5);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('HISTORY_BUDGET_RATIO');
  });
});
