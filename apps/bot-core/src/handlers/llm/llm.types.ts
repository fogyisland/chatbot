// v0.6: widened to include 'summary' for sliding-window summarization. Providers
// should NOT see 'summary' rows — LlmHandler filters them before the API call.
export type ChatRole = 'user' | 'assistant' | 'system' | 'summary';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage: ChatUsage;
}

export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly contextWindow: number;
  chat(req: ChatRequest): Promise<ChatResponse>;
  countTokens(text: string): number;
}