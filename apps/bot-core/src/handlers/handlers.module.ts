import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { HandlerRegistry } from './handler.interface';
import { ClaudeProvider } from './llm/providers/claude.provider';
import { OpenAIProvider } from './llm/providers/openai.provider';
import { TongyiProvider } from './llm/providers/tongyi.provider';
import { DeepSeekProvider } from './llm/providers/deepseek.provider';
import { FallbackProvider } from './llm/fallback.provider';
import { LlmHandler } from './llm/llm.handler';
import { UsageLogger } from './llm/usage-logger';
import { KbHandler } from './kb/kb.handler';
import { QdrantKbClient } from './kb/qdrant.client';
import { HttpEmbedder } from './kb/embedder';
import { ToolRegistry } from './tool/tool.handler';
import { translateTool } from './tool/builtin/translate.tool';
import { weatherTool } from './tool/builtin/weather.tool';

@Module({
  providers: [
    UsageLogger,
    {
      provide: ClaudeProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new ClaudeProvider(cfg),
    },
    {
      provide: OpenAIProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new OpenAIProvider({ apiKey: cfg.openaiApiKey ?? 'no-key' }),
    },
    {
      provide: TongyiProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new TongyiProvider({ apiKey: cfg.dashscopeApiKey ?? 'no-key' }),
    },
    {
      provide: DeepSeekProvider,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new DeepSeekProvider({ apiKey: cfg.deepseekApiKey ?? 'no-key' }),
    },
    {
      provide: FallbackProvider,
      inject: [TongyiProvider, DeepSeekProvider, OpenAIProvider, ClaudeProvider],
      useFactory: (ty: TongyiProvider, ds: DeepSeekProvider, oa: OpenAIProvider, cl: ClaudeProvider) =>
        new FallbackProvider([ty, ds, oa, cl]),
    },
    {
      provide: LlmHandler,
      inject: [FallbackProvider, UsageLogger],
      useFactory: (fb: FallbackProvider, ul: UsageLogger) => new LlmHandler(fb, ul),
    },
    {
      provide: QdrantKbClient,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new QdrantKbClient({ url: cfg.qdrantUrl, vectorDim: 1024 }),
    },
    {
      provide: HttpEmbedder,
      inject: [ConfigService],
      useFactory: () => new HttpEmbedder({
        url: process.env.EMBEDDING_URL ?? 'http://localhost:8080',
        apiKey: process.env.EMBEDDING_API_KEY ?? 'no-key',
        model: process.env.EMBEDDING_MODEL ?? 'bge-large-zh-v1.5',
      }),
    },
    {
      provide: KbHandler,
      inject: [QdrantKbClient, HttpEmbedder, FallbackProvider],
      useFactory: (q: QdrantKbClient, e: HttpEmbedder, fb: FallbackProvider) =>
        new KbHandler({ qdrant: q, embedder: e, llm: fb }),
    },
    {
      provide: ToolRegistry,
      inject: [FallbackProvider],
      useFactory: (fb: FallbackProvider) => {
        const reg = new ToolRegistry();
        reg.register(weatherTool());
        reg.register(translateTool({ defaultModel: () => fb }));
        return reg;
      },
    },
    {
      provide: HandlerRegistry,
      inject: [LlmHandler, KbHandler, ToolRegistry],
      useFactory: (llm: LlmHandler, kb: KbHandler, tools: ToolRegistry) => {
        const reg = new HandlerRegistry();
        reg.register(llm);
        reg.register(kb);
        reg.register(tools);
        return reg;
      },
    },
  ],
  // v0.6.0: UsageLogger is also exported so SummarizerModule (sibling) can
  // DI-inject it when constructing SummarizationService. Without this export,
  // `NestFactory.create(AppModule)` crashes at startup with:
  //   "Nest can't resolve dependencies of the SummarizationService
  //    (... UsageLogger at index [1] is not available in the SummarizerModule
  //    context)" — caught by app-module.di.test.ts whole-branch canary.
  exports: [HandlerRegistry, LlmHandler, KbHandler, ToolRegistry, FallbackProvider, UsageLogger],
})
export class HandlersModule {}
