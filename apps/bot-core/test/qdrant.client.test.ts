import { QdrantKbClient } from '../src/handlers/kb/qdrant.client';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('QdrantKbClient', () => {
  it('ensureCollection creates collection when GET returns 404', async () => {
    const calls: Array<{ url: any; init: any }> = [];
    let firstCall = true;
    global.fetch = async (url: any, init: any) => {
      calls.push({ url, init });
      if (firstCall) {
        firstCall = false;
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' } as any;
      }
      return { ok: true, status: 200, json: async () => ({ result: true }) } as any;
    };

    const client = new QdrantKbClient({ url: 'http://localhost:6333', vectorDim: 4 });
    await client.ensureCollection();

    expect(calls.length).toBe(2);
    expect(String(calls[0].url)).toContain('/collections/kb_chunks');
    expect(calls[0].init.method).toBe('GET');
    expect(String(calls[1].url)).toContain('/collections/kb_chunks');
    expect(calls[1].init.method).toBe('PUT');
    const body = JSON.parse(calls[1].init.body);
    expect(body.vectors.size).toBe(4);
    expect(body.vectors.distance).toBe('Cosine');
  });

  it('search posts vector and returns payload results', async () => {
    let captured: { url: any; init: any } | null = null;
    global.fetch = async (url: any, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: [
            { id: 'p1', score: 0.91, payload: { text: 'hello', source: 'doc1' } },
            { id: 'p2', score: 0.82, payload: { text: 'world', source: 'doc2' } },
          ],
        }),
      } as any;
    };

    const client = new QdrantKbClient({ url: 'http://localhost:6333', vectorDim: 4 });
    const results = await client.search([0.1, 0.2, 0.3, 0.4], 3);

    expect(captured).not.toBeNull();
    expect(String(captured!.url)).toContain('/collections/kb_chunks/points/search');
    expect(captured!.init.method).toBe('POST');
    const body = JSON.parse(captured!.init.body);
    expect(body.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(body.top).toBe(3);
    expect(body.with_payload).toBe(true);

    expect(results).toEqual([
      { id: 'p1', score: 0.91, payload: { text: 'hello', source: 'doc1' } },
      { id: 'p2', score: 0.82, payload: { text: 'world', source: 'doc2' } },
    ]);
  });
});
