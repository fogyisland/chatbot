import { LlmProvider } from '../llm/llm.types';

/**
 * v0.6: typed failure when all summarizer providers in the chain fail.
 * Carries the original error as `.cause` for logging context.
 */
export class SummarizationUnavailableError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('summarization service unavailable (all providers failed)');
    this.name = 'SummarizationUnavailableError';
    this.cause = cause;
  }
}

/** v0.6: DI token for the ordered list of summarizer LlmProvider instances. */
export const SUMMARIZER_PROVIDERS = Symbol('SUMMARIZER_PROVIDERS');

/**
 * v0.6: system prompt for the summarizer small-LLM call. Hard rule:
 * a single paragraph, plain prose, no role labels, drop pleasantries,
 * preserve names/facts/decisions/questions.
 */
export const SUMMARIZER_SYSTEM_PROMPT = [
  'You are a conversation history compactor.',
  'Your task: produce a SINGLE-PARAGRAPH summary of the conversation below.',
  'Preserve: key facts, names, decisions made, questions asked, and the user\'s current goal.',
  'Drop: pleasantries, greetings, repeated clarifications.',
  'Output: plain prose. No bullet lists. No role labels (do not write "User:" or "Assistant:").',
  'Length: as short as possible while preserving the above. Target ≤ 200 words.',
].join(' ');

/** Header injected in front of a prior session summary so the small LLM sees "merge, not append". */
export const PREVIOUS_SUMMARY_HEADER = 'PREVIOUS SUMMARY (merge this with the new turns below):\n';

// Provider-name string → LlmProvider type alias (purely documentary).
export type SummarizerProviderName = 'claude-haiku' | 'openai-mini' | string;

// Re-export the imported LlmProvider so consumers can `import { LlmProvider } from '.../summarizer.types'`
// without pulling the deeper `./llm/llm.types` path.
export type { LlmProvider };
