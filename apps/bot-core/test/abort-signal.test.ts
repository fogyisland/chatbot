import { LlmHandler } from '../src/handlers/llm/llm.handler';
import { KbHandler } from '../src/handlers/kb/kb.handler';
import { HandlerContext } from '../src/handlers/handler.interface';

const ctx = (signal: AbortSignal): HandlerContext => ({
  userId: 'u1',
  chatId: 'c1',
  platform: 'wechat',
  history: [],
  abortSignal: signal,
});

describe('AbortSignal forwarding', () => {
  it('LlmHandler forwards ctx.abortSignal into ChatRequest.signal', async () => {
    let captured: AbortSignal | undefined;
    const provider: any = {
      name: 'stub',
      defaultModel: 'm',
      chat: async (req: any) => {
        captured = req.signal;
        return { text: 'r', model: 'm', usage: { promptTokens: 1, completionTokens: 1 } };
      },
      countTokens: () => 1,
    };
    const usage: any = { record: async () => {} };
    const handler = new LlmHandler(provider, usage);

    const signal = AbortSignal.timeout(30_000);
    await handler.handle({ kind: 'llm', prompt: 'hi' }, ctx(signal));

    expect(captured).toBe(signal);
    expect(captured!.aborted).toBe(false);
  });

  it('KbHandler forwards ctx.abortSignal into ChatRequest.signal', async () => {
    let captured: AbortSignal | undefined;
    const llm: any = {
      name: 'stub',
      defaultModel: 'm',
      chat: async (req: any) => {
        captured = req.signal;
        return { text: 'r', model: 'm', usage: { promptTokens: 1, completionTokens: 1 } };
      },
      countTokens: () => 1,
    };
    const embedder: any = { embedBatch: async () => [[0.1, 0.2, 0.3]] };
    const qdrant: any = { search: async () => [] };

    const handler = new KbHandler({ qdrant, embedder, llm });
    const signal = AbortSignal.timeout(30_000);
    await handler.handle({ kind: 'kb', query: 'what?' }, ctx(signal));

    // If search returns [], kb returns immediately without chat; capture is undefined.
    // Re-run with a hit so the chat() path is exercised.
    qdrant.search = async () => [{ payload: { doc_title: 't', content_preview: 'p' } }];
    await handler.handle({ kind: 'kb', query: 'what?' }, ctx(signal));

    expect(captured).toBe(signal);
    expect(captured!.aborted).toBe(false);
  });

  it('AbortSignal.timeout(30_000) yields a non-aborted signal under fast path', () => {
    const s = AbortSignal.timeout(30_000);
    expect(s.aborted).toBe(false);
  });
});