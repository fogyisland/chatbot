import { ConfigService } from '../src/common/config/config.service';

const ORIGINAL_ENV = process.env.HISTORY_TOKEN_BUDGET;

describe('ConfigService.historyTokenBudget', () => {
  let svc: ConfigService;

  beforeEach(() => {
    delete process.env.HISTORY_TOKEN_BUDGET;
    svc = new ConfigService();
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.HISTORY_TOKEN_BUDGET;
    else process.env.HISTORY_TOKEN_BUDGET = ORIGINAL_ENV;
  });

  it('returns 6000 when env unset', () => {
    expect(svc.historyTokenBudget).toBe(6000);
  });

  it('returns the env value when valid positive integer', () => {
    process.env.HISTORY_TOKEN_BUDGET = '12345';
    expect(svc.historyTokenBudget).toBe(12345);
  });

  it('returns 0 when env is "0" (disables budget)', () => {
    process.env.HISTORY_TOKEN_BUDGET = '0';
    expect(svc.historyTokenBudget).toBe(0);
  });

  it('falls back to 6000 when env is negative', () => {
    process.env.HISTORY_TOKEN_BUDGET = '-1';
    expect(svc.historyTokenBudget).toBe(6000);
  });

  it('falls back to 6000 when env is unparseable', () => {
    process.env.HISTORY_TOKEN_BUDGET = 'abc';
    expect(svc.historyTokenBudget).toBe(6000);
  });
});
