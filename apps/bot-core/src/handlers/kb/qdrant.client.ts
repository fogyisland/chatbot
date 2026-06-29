/**
 * Minimal Qdrant HTTP client used for the knowledge base.
 *
 * Wire-up into HandlersModule happens in a later task. For now this is a
 * plain class so it can be instantiated and unit-tested without DI.
 */

export interface QdrantKbClientOptions {
  /** Base URL of the Qdrant HTTP API (e.g. http://localhost:6333). */
  url: string;
  /** Dimensionality of the vectors that will be stored. */
  vectorDim: number;
  /** Optional collection name. Defaults to `kb_chunks`. */
  collectionName?: string;
}

export interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

export interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

export class QdrantKbClient {
  private readonly baseUrl: string;
  private readonly vectorDim: number;
  private readonly collectionName: string;

  constructor(opts: QdrantKbClientOptions) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.vectorDim = opts.vectorDim;
    this.collectionName = opts.collectionName ?? 'kb_chunks';
  }

  /**
   * Ensure the collection exists. If the GET /collections/{name} call
   * returns a non-OK status, attempts to create the collection via
   * PUT /collections/{name} with Cosine distance. Throws on PUT failure
   * with the upstream status code and response body for diagnostics.
   */
  async ensureCollection(): Promise<void> {
    const collectionUrl = `${this.baseUrl}/collections/${this.collectionName}`;

    const getRes = await fetch(collectionUrl, { method: 'GET' });
    if (getRes.ok) {
      return;
    }

    const putRes = await fetch(collectionUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vectors: { size: this.vectorDim, distance: 'Cosine' },
      }),
    });

    if (!putRes.ok) {
      const body = await putRes.text();
      throw new Error(`qdrant create collection failed: ${putRes.status} ${body}`);
    }
  }

  /**
   * Upsert one or more points into the collection. Each point must
   * include a stable id, a vector of dimension `vectorDim`, and optional
   * payload metadata.
   */
  async upsert(points: QdrantPoint[]): Promise<void> {
    const url = `${this.baseUrl}/collections/${this.collectionName}/points`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ points }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`qdrant upsert failed: ${res.status} ${body}`);
    }
  }

  /**
   * Search the collection for the top-K nearest neighbors of `vector`.
   * Returns an empty array if the upstream response is missing `result`.
   */
  async search(vector: number[], topK: number): Promise<QdrantSearchResult[]> {
    const url = `${this.baseUrl}/collections/${this.collectionName}/points/search`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vector,
        top: topK,
        with_payload: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`qdrant search failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as { result?: QdrantSearchResult[] };
    return json.result ?? [];
  }
}
