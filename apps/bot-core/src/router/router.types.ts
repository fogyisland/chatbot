import { RouteDecision } from '@mpcb/shared';

export interface RouteContext {
  userId: string;
  chatId: string;
  platform: 'wechat' | 'teams' | 'dingtalk';
  // v0.6: widened to include 'summary' so loadOrBuildHistory can hand summary
  // rows through. Router doesn't read history; consumers strip summary rows
  // before passing to LLM APIs (see LlmHandler in T6).
  history: Array<{ role: 'user' | 'assistant' | 'system' | 'summary'; content: string }>;
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
