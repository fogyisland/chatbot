import { Module } from '@nestjs/common';
import { ConfigService } from '../../common/config/config.service';
import { UsageLogger } from '../llm/usage-logger';
import { HandlersModule } from '../handlers.module';
import { ClaudeHaikuProvider } from './providers/claude-haiku.provider';
import { OpenAIMiniProvider } from './providers/openai-mini.provider';
import { SummarizationService } from './summarizer.service';
import { SUMMARIZER_PROVIDERS } from './summarizer.types';
import { LlmProvider } from '../llm/llm.types';

/**
 * v0.6: wires the dedicated summarizer provider chain.
 *
 * Reads SUMMARIZER_PROVIDERS env (csv) to decide which providers are in
 * the chain, in order. Each string maps to a registered provider instance:
 *   - 'claude-haiku'  → ClaudeHaikuProvider
 *   - 'openai-mini'   → OpenAIMiniProvider
 * Unknown names fall back to claude-haiku (warn-once via ConfigService).
 *
 * Default chain (when env unset): ['claude-haiku', 'openai-mini'].
 */
@Module({
  // v0.6.0: import HandlersModule so UsageLogger (exported from there) is
  // available to SummarizationService's factory. Without this, NestJS
  // cannot resolve the SummarizationService constructor's 2nd argument
  // (`usage: UsageLogger`) and AppModule fails to compile. See
  // app-module.di.test.ts for the whole-branch canary.
  imports: [HandlersModule],
  providers: [
    {
      provide: ClaudeHaikuProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new ClaudeHaikuProvider(cfg),
    },
    {
      provide: OpenAIMiniProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new OpenAIMiniProvider(cfg),
    },
    {
      provide: SUMMARIZER_PROVIDERS,
      inject: [ConfigService, ClaudeHaikuProvider, OpenAIMiniProvider],
      useFactory: (
        cfg: ConfigService,
        claude: ClaudeHaikuProvider,
        openai: OpenAIMiniProvider,
      ): LlmProvider[] => {
        const registry: Record<string, LlmProvider> = {
          'claude-haiku': claude,
          'openai-mini': openai,
        };
        const chain: LlmProvider[] = [];
        for (const name of cfg.summarizerProviderChain) {
          const p = registry[name];
          if (p) chain.push(p);
          // Else: silently skip unknown names (defensive — ConfigService defaults
          // already cover the documented set).
        }
        return chain.length > 0 ? chain : [claude];   // always at least one provider
      },
    },
    {
      provide: SummarizationService,
      inject: [SUMMARIZER_PROVIDERS, UsageLogger, ConfigService],
      useFactory: (
        providers: LlmProvider[],
        usage: UsageLogger,
        cfg: ConfigService,
      ) => new SummarizationService(providers, usage, cfg),
    },
  ],
  exports: [SummarizationService],
})
export class SummarizerModule {}
