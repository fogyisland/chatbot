import { ConfigService } from '../src/common/config/config.service';

describe('ConfigService summarization getters', () => {
  let svc: ConfigService;
  let warnSpy: jest.SpyInstance;

  // Snapshot original env keys we'll touch, so afterAll can restore.
  const ENV_KEYS = [
    'ENABLE_SUMMARIZATION',
    'SUMMARIZER_PROVIDERS',
    'SUMMARIZER_CONTEXT_WINDOW',
  ];
  const SAVED: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    svc = new ConfigService();
    warnSpy = jest
      .spyOn((svc as any).logger ?? console, 'warn')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  // ---- enableSummarization ----

  it('enableSummarization defaults to false when env unset', () => {
    expect(svc.enableSummarization).toBe(false);
  });

  it('enableSummarization returns true for truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes']) {
      process.env.ENABLE_SUMMARIZATION = v;
      expect(svc.enableSummarization).toBe(true);
    }
  });

  it('enableSummarization returns false for falsy/garbage values', () => {
    for (const v of ['false', '0', 'no', 'off', 'abc', '']) {
      process.env.ENABLE_SUMMARIZATION = v;
      expect(svc.enableSummarization).toBe(false);
    }
  });

  // ---- summarizerProviderChain ----

  it('summarizerProviderChain defaults to [claude-haiku, openai-mini] when env unset', () => {
    expect(svc.summarizerProviderChain).toEqual(['claude-haiku', 'openai-mini']);
  });

  it('summarizerProviderChain parses a custom comma-list', () => {
    process.env.SUMMARIZER_PROVIDERS = 'claude-haiku,deepseek-chat,openai-mini';
    expect(svc.summarizerProviderChain).toEqual([
      'claude-haiku',
      'deepseek-chat',
      'openai-mini',
    ]);
  });

  // ---- summarizerContextWindow ----

  it('summarizerContextWindow defaults to 100_000 when env unset', () => {
    expect(svc.summarizerContextWindow).toBe(100_000);
  });

  it('summarizerContextWindow parses valid integer override', () => {
    process.env.SUMMARIZER_CONTEXT_WINDOW = '250000';
    expect(svc.summarizerContextWindow).toBe(250_000);
  });

  it('summarizerContextWindow falls back to 100_000 on garbage', () => {
    process.env.SUMMARIZER_CONTEXT_WINDOW = 'abc';
    expect(svc.summarizerContextWindow).toBe(100_000);
  });
});
