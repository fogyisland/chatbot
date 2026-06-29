import { HttpEmbedder } from '../src/handlers/kb/embedder';

describe('HttpEmbedder', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('embedBatch posts to embeddings endpoint and returns vectors', async () => {
    global.fetch = async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        json: async () => ({
          data: body.input.map((_: string, i: number) => ({ embedding: new Array(4).fill(i + 1) })),
        }),
      } as any;
    };
    const e = new HttpEmbedder({ url: 'https://emb.example.com', apiKey: 'k', model: 'bge' });
    const v = await e.embedBatch(['a', 'b']);
    expect(v.length).toBe(2);
    expect(v[0][0]).toBe(1);
    expect(v[1][0]).toBe(2);
  });
});
