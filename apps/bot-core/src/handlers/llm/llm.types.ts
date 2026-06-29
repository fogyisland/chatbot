export type ChatRole = 'user' | 'assistant' | 'system';

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
  chat(req: ChatRequest): Promise<ChatResponse>;
  countTokens(text: string): number;
}