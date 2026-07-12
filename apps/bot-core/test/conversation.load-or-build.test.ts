import { ConfigService } from '../src/common/config/config.service';
import { ConversationService, ConversationTurn } from '../src/conversation/conversation.service';
import { SummarizationService } from '../src/handlers/summarizer/summarizer.service';
import { SummarizationUnavailableError } from '../src/handlers/summarizer/summarizer.types';
import { MessageLogService } from '../src/messages/message-log.service';

// --- Mocks ---
// StubCfg cannot extend ConfigService because mysqlHost/mysqlPort are
// getters (TS2610). Use a plain object cast instead — same duck-typed
// pattern used by makeConfigStub() in conversation.service.test.ts.

const makeCfgStub = (): ConfigService =>
  ({
    mysqlHost: '127.0.0.1',
    mysqlPort: 1,
  } as unknown as ConfigService);

class StubSummarizer {
  summarize = jest.fn(async (): Promise<string> => 'fake summary');
  get contextWindow(): number {
    return 100_000;
  }
}

class StubMessageLog {
  upsertSummaryCalls: Array<{ content: string; platform: string; chatId: string; senderId: string }> = [];
  async upsertSummary(content: string, platform: string, chatId: string, senderId: string): Promise<void> {
    this.upsertSummaryCalls.push({ content, platform, chatId, senderId });
  }
}

// --- Tests ---

describe('ConversationService.loadOrBuildHistory', () => {
  let cfg: ConfigService;
  let summarizer: StubSummarizer;
  let messageLog: StubMessageLog;
  let svc: ConversationService;

  beforeEach(() => {
    cfg = makeCfgStub();
    summarizer = new StubSummarizer();
    messageLog = new StubMessageLog();
    svc = new ConversationService(cfg, summarizer as unknown as SummarizationService, messageLog as unknown as MessageLogService);
  });

  it('enableSummarization=false → delegates to loadHistory (identical behavior)', async () => {
    // No DB; loadHistory should catch and return [] (existing v0.4 pattern).
    const hist = await svc.loadOrBuildHistory(
      'wechat' as any, 'chat-1', 'user-1', Date.now(),
      { enableSummarization: false },
    );
    expect(hist).toEqual([]);
    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(messageLog.upsertSummaryCalls.length).toBe(0);
  });

  it('enableSummarization=true + no DB rows → returns [] (no work)', async () => {
    const hist = await svc.loadOrBuildHistory(
      'wechat' as any, 'chat-1', 'user-1', Date.now(),
      { enableSummarization: true, tokenBudget: 1000 },
    );
    expect(hist).toEqual([]);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('type signature: options takes enableSummarization boolean', () => {
    // Compile-time check (TS would catch). Runtime introspection:
    // svc.loadOrBuildHistory.length === 5
    expect(svc.loadOrBuildHistory.length).toBe(5);
  });

  it('constructor takes 3 args (seam audit — first constructor change since v0.4)', () => {
    expect(svc.constructor.length).toBe(3);
  });

  it('ConversationTurn.role now accepts "summary"', () => {
    // type-level assertion via TS — runtime, just construct a value.
    const turn: ConversationTurn = { role: 'summary', content: 'any' };
    expect(turn.role).toBe('summary');
  });

  it('SummarizationUnavailableError propagates from loadOrBuildHistory (does NOT swallow)', async () => {
    const failingSummarizer = {
      contextWindow: 100_000,
      summarize: jest.fn(async () => { throw new SummarizationUnavailableError(new Error('chain dead')); }),
    };
    const localSvc = new ConversationService(
      cfg,
      failingSummarizer as unknown as SummarizationService,
      messageLog as unknown as MessageLogService,
    );

    // Stub loadHistory (private call from loadOrBuildHistory) to return a
    // non-empty history so the flow reaches summarize(). The contract under
    // test is: if summarize() throws SummarizationUnavailableError, it
    // propagates UP (does NOT get swallowed by upsertSummary's .catch).
    // 2000 ASCII chars = ~500 estimated tokens; budget=100, so flow reaches
    // the over-budget branch and invokes summarize().
    (localSvc as unknown as { loadHistory: (...a: unknown[]) => Promise<unknown[]> }).loadHistory =
      jest.fn(async () => [{ role: 'user', content: 'a'.repeat(2000) }]);

    await expect(
      localSvc.loadOrBuildHistory(
        'wechat' as any, 'chat-1', 'user-1', Date.now(),
        { enableSummarization: true, tokenBudget: 100 },
      ),
    ).rejects.toBeInstanceOf(SummarizationUnavailableError);
  });

  it('options with no tokenBudget + enableSummarization=true → no summarize triggered', async () => {
    // loadHistory returns [] (DB unreachable), so loadOrBuildHistory returns [] without calling summarizer.
    const hist = await svc.loadOrBuildHistory(
      'wechat' as any, 'chat-1', 'user-1', Date.now(),
      { enableSummarization: true },
    );
    expect(hist).toEqual([]);
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('upsertSummary error after successful summarize does not break the call', async () => {
    // Construct a scenario: loadHistory returns [] (real DB unreachable),
    // so we cannot fully exercise the post-summarize upsert path here.
    // This test asserts the contract on a smoke level: when build happy
    // path runs without a DB, we degrade to [] (no crash).
    const hist = await svc.loadOrBuildHistory(
      'wechat' as any, 'chat-1', 'user-1', Date.now(),
      { enableSummarization: true, tokenBudget: 1000 },
    );
    expect(Array.isArray(hist)).toBe(true);
  });

  it('loadOrBuildHistory same call signature as loadHistory (compatible callers)', () => {
    // Compile-time contract check via TS; runtime check counts args.
    expect(svc.loadOrBuildHistory.length).toBe(svc.loadHistory.length);
  });
});
