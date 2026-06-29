export interface Embedder {
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface HttpEmbedderOptions {
  url: string;
  apiKey: string;
  model: string;
}

export class HttpEmbedder implements Embedder {
  constructor(private readonly opts: HttpEmbedderOptions) {}

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.opts.url}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embedder ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return (json.data ?? []).map((d: any) => d.embedding);
  }
}
