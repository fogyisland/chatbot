import { ChatRequest, ChatResponse, LlmProvider, ChatMessage } from '../llm.types';

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

interface DeepSeekResponse {
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  readonly defaultModel: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: DeepSeekProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.deepseek.com';
    this.defaultModel = opts.defaultModel ?? 'deepseek-chat';
  }

  countTokens(text: string): number {
    // Approximate: ~4 chars per token for English/mixed CJK
    return Math.ceil(text.length / 4);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.opts.apiKey) {
      throw new Error('deepseek apiKey is required');
    }

    const model = req.model || this.defaultModel;

    const systemMessages: ChatMessage[] = req.systemPrompt
      ? [{ role: 'system', content: req.systemPrompt }]
      : [];
    const messages = [
      ...systemMessages,
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body = {
      model,
      max_tokens: req.maxTokens ?? 1024,
      messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    const url = `${this.baseUrl}/chat/completions`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      throw new Error(`deepseek request failed: ${(e as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`deepseek ${res.status}: ${body}`);
    }

    let json: DeepSeekResponse;
    try {
      json = (await res.json()) as DeepSeekResponse;
    } catch {
      throw new Error(`deepseek non-JSON response (status ${res.status})`);
    }

    const text = json.choices?.[0]?.message?.content ?? '';

    return {
      text,
      model: json.model || model,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}
