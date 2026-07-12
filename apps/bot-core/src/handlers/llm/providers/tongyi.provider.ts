import { ChatRequest, ChatResponse, LlmProvider, ChatMessage } from '../llm.types';
import { estimateTokens } from '@mpcb/shared';

export interface TongyiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

interface TongyiResponse {
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

export class TongyiProvider implements LlmProvider {
  readonly name = 'tongyi';
  readonly defaultModel: string;
  readonly contextWindow: number;
  private readonly baseUrl: string;

  constructor(private readonly opts: TongyiProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://dashscope.aliyuncs.com';
    this.defaultModel = opts.defaultModel ?? 'qwen-turbo';
    this.contextWindow = 8_000;
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.opts.apiKey) {
      throw new Error('tongyi apiKey is required');
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

    const url = `${this.baseUrl}/compatible-mode/v1/chat/completions`;

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
      throw new Error(`tongyi request failed: ${(e as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`tongyi ${res.status}: ${body}`);
    }

    let json: TongyiResponse;
    try {
      json = (await res.json()) as TongyiResponse;
    } catch {
      throw new Error(`tongyi non-JSON response (status ${res.status})`);
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
