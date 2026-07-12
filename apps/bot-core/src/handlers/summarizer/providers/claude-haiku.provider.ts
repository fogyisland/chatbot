import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../../common/config/config.service';
import { ClaudeProvider } from '../../llm/providers/claude.provider';

/**
 * v0.6: dedicated summarizer provider — extends ClaudeProvider, overrides
 * `name` (so usage_log.provider = 'claude-haiku' identifies cheap-tier calls)
 * and `defaultModel` (the small Claude model). Reuses all API-calling logic.
 */
@Injectable()
export class ClaudeHaikuProvider extends ClaudeProvider {
  override readonly name = 'claude-haiku';
  override readonly defaultModel = 'claude-haiku-4-5';
  constructor(cfg: ConfigService) {
    super(cfg);
  }
}
