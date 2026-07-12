import { ConfigService } from '../src/common/config/config.service';
import { SummarizationService } from '../src/handlers/summarizer/summarizer.service';
import { UsageLogger } from '../src/handlers/llm/usage-logger';
import { LlmProvider, ChatRequest, ChatResponse } from '../src/handlers/llm/llm.types';
import { ConversationTurn } from '../src/conversation/conversation.service';
import {
  SummarizationUnavailableError,
  PREVIOUS_SUMMARY_HEADER,
  SUMMARIZER_SYSTEM_PROMPT,
} from '../src/handlers/summarizer/summarizer.types';

class StubProvider implements LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly contextWindow = 200_000;
  public lastReq: ChatRequest | null = null;
  public response: ChatResponse;
  public failWith: Error | null = null;

  constructor(name: string, defaultModel: string, response: ChatResponse) {
    this.name = name;
    this.defaultModel = defaultModel;
    this.response = response;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.lastReq = req;
    if (this.failWith) throw this.failWith;
    return this.response;
  }
}

class StubUsageLogger {
  public calls: Array<{ provider: string; model: string; usage: any; userId?: string }> = [];
  async record(args: { userId?: string; provider: string; model: string; usage: any }): Promise<void> {
    this.calls.push(args);
  }
}

const TURN = (role: 'user' | 'assistant', content: string): ConversationTurn => ({ role, content });

describe('SummarizationService', () => {
  let cfg: ConfigService;
  let usage: StubUsageLogger;
  beforeEach(() => {
    delete process.env.SUMMARIZER_CONTEXT_WINDOW;
    delete process.env.SUMMARIZER_PROVIDERS;
    delete process.env.ENABLE_SUMMARIZATION;
    cfg = new ConfigService();
    usage = new StubUsageLogger();
  });

  it('happy path: calls first provider, returns response text, records usage', async () => {
    const stub = new StubProvider('claude-haiku', 'claude-haiku-4-5', {
      text: 'summary text',
      model: 'claude-haiku-4-5',
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const svc = new SummarizationService([stub], usage as unknown as UsageLogger, cfg);
    const turns: ConversationTurn[] = [
      TURN('user', 'hello'),
      TURN('assistant', 'hi there, how can I help?'),
      TURN('user', 'what is X?'),
    ];
    const text = await svc.summarize(turns, AbortSignal.timeout(5_000));
    expect(text).toBe('summary text');
    expect(stub.lastReq?.model).toBe('claude-haiku-4-5');
    // usage was recorded with the actual provider name (for cost tracking)
    expect(usage.calls.length).toBe(1);
    expect(usage.calls[0].provider).toBe('claude-haiku');
    // system prompt passed through
    expect(stub.lastReq?.systemPrompt).toBe(SUMMARIZER_SYSTEM_PROMPT);
  });

  it('falls back to next provider in chain when the first throws', async () => {
    const first = new StubProvider('claude-haiku', 'claude-haiku-4-5', {
      text: 'should not see', model: 'x', usage: { promptTokens: 0, completionTokens: 0 },
    });
    first.failWith = new Error('boom');
    const second = new StubProvider('openai-mini', 'gpt-4o-mini', {
      text: 'fallback ok', model: 'gpt-4o-mini', usage: { promptTokens: 50, completionTokens: 10 },
    });
    const svc = new SummarizationService([first, second], usage as unknown as UsageLogger, cfg);
    const text = await svc.summarize([TURN('user', 'hi')], AbortSignal.timeout(5_000));
    expect(text).toBe('fallback ok');
    expect(usage.calls.length).toBe(1);
    expect(usage.calls[0].provider).toBe('openai-mini');
  });

  it('throws SummarizationUnavailableError when ALL providers in chain fail', async () => {
    const a = new StubProvider('claude-haiku', 'claude-haiku-4-5', {
      text: '', model: '', usage: { promptTokens: 0, completionTokens: 0 },
    });
    a.failWith = new Error('a-bad');
    const b = new StubProvider('openai-mini', 'gpt-4o-mini', {
      text: '', model: '', usage: { promptTokens: 0, completionTokens: 0 },
    });
    b.failWith = new Error('b-bad');
    const svc = new SummarizationService([a, b], usage as unknown as UsageLogger, cfg);
    await expect(
      svc.summarize([TURN('user', 'hi')], AbortSignal.timeout(5_000)),
    ).rejects.toBeInstanceOf(SummarizationUnavailableError);
    expect(usage.calls.length).toBe(0);
  });

  it('pre-trims oldest turns if input exceeds 70% of contextWindow', async () => {
    const stub = new StubProvider('claude-haiku', 'claude-haiku-4-5', {
      text: 'compacted', model: 'claude-haiku-4-5', usage: { promptTokens: 0, completionTokens: 0 },
    });
    // Set contextWindow very small so the pre-trim kicks in.
    process.env.SUMMARIZER_CONTEXT_WINDOW = '20';  // input cap = 14 tokens
    cfg = new ConfigService();
    const svc = new SummarizationService([stub], usage as unknown as UsageLogger, cfg);
    const turns: ConversationTurn[] = [
      TURN('user', 'aaaaaa bbbbbb cccccc dddddd eeeeee'), // ~30+ tokens
      TURN('assistant', 'ffff gggg hhhh iiii jjjj'),     // ~25+ tokens
      TURN('user', 'kkkk llll mmmm nnnn oooo'),           // recent turn, must survive
    ];
    const text = await svc.summarize(turns, AbortSignal.timeout(5_000));
    expect(text).toBe('compacted');
    // The most-recent turn MUST be in the request message content (pre-trim drops oldest).
    const sent = (stub.lastReq!.messages[0].content) as string;
    expect(sent).toContain('kkkk');
  });

  // Silence unused-import warning (PREVIOUS_SUMMARY_HEADER is referenced indirectly via service internals)
  it('exports PREVIOUS_SUMMARY_HEADER marker for incremental-merge format', () => {
    expect(PREVIOUS_SUMMARY_HEADER).toContain('PREVIOUS SUMMARY');
  });
});
