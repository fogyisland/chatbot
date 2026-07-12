import { OpenAIProvider } from '../../llm/providers/openai.provider';
import { ConfigService } from '../../../common/config/config.service';

/**
 * v0.6: dedicated summarizer provider — extends OpenAIProvider, overrides
 * `name` (so usage_log.provider = 'openai-mini') and `defaultModel`
 * (gpt-4o-mini, which OpenAIProvider already defaults to, but explicit
 * here so the override pattern matches ClaudeHaikuProvider).
 */
export class OpenAIMiniProvider extends OpenAIProvider {
  override readonly name = 'openai-mini';
  override readonly defaultModel = 'gpt-4o-mini';
  constructor(cfg: ConfigService) {
    super({ apiKey: cfg.openaiApiKey ?? 'no-key' });
  }
}
