import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../../common/config/config.service';
import { ChatRequest, ChatResponse, LlmProvider, ChatMessage } from '../llm.types';

const ANTHROPIC_VERSION = '2023-06-01';

interface ClaudeResponse {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

@Injectable()
export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  readonly defaultModel = 'claude-3-5-sonnet-20241022';
  private readonly logger = new Logger(ClaudeProvider.name);
  private readonly baseUrl = 'https://api.anthropic.com';

  constructor(private readonly config: ConfigService) {}

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = this.config.anthropicApiKey;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }

    const model = req.model || this.defaultModel;
    const systemMessages: ChatMessage[] = req.systemPrompt
      ? [{ role: 'system', content: req.systemPrompt }]
      : [];
    const messages = [...systemMessages, ...req.messages];

    const body = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens ?? 1024,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    const url = `${this.baseUrl}/v1/messages`;
    this.logger.log(`POST ${url} model=${model}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      throw new Error(`claude request failed: ${(e as Error).message}`);
    }

    let json: ClaudeResponse;
    try {
      json = (await res.json()) as ClaudeResponse;
    } catch {
      throw new Error(`claude non-JSON response (status ${res.status})`);
    }

    if (!res.ok) {
      const msg = json.error?.message || `claude HTTP ${res.status}`;
      throw new Error(msg);
    }

    const text = (json.content || [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');

    return {
      text,
      model: json.model || model,
      usage: {
        promptTokens: json.usage?.input_tokens ?? 0,
        completionTokens: json.usage?.output_tokens ?? 0,
      },
    };
  }
}