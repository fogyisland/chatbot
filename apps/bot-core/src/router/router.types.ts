import { RouteDecision } from '@mpcb/shared';

export interface RouteContext {
  userId: string;
  chatId: string;
  platform: 'wechat' | 'teams' | 'dingtalk';
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  abortSignal: AbortSignal;
}

export interface RouterConfig {
  commands: Record<string, 'help' | 'clear' | 'status' | 'forget'>;
  prefixes: Record<string, string>;
  defaultHandler: 'llm' | 'kb' | 'tool';
  commandOnly: boolean;
  forgetReply: 'verbose' | 'silent';
}

export { RouteDecision };
