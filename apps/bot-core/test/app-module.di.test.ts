import { Test } from '@nestjs/testing';
import { RouterModule } from '../src/router/router.module';
import { RouterService } from '../src/router/router.service';
import { ConfigService } from '../src/common/config/config.service';
import { AppModule } from '../src/app.module';
import { UsageLogger } from '../src/handlers/llm/usage-logger';

describe('RouterService DI', () => {
  it('resolves RouterService via the RouterModule DI graph', async () => {
    // This loads RouterModule directly. The v0.3.0 bug was a bare
    // `providers: [RouterService]` declaration: the constructor takes a
    // union-typed `source` parameter that NestJS cannot DI-resolve. NestJS
    // throws `Nest can't resolve dependencies of the RouterService` at
    // .compile() time. v0.3.1 replaces the bare provider with a useFactory
    // that injects RouterConfigStore.
    const moduleRef = await Test.createTestingModule({
      imports: [RouterModule],
    })
      .useMocker((token) => {
        if (token === ConfigService) {
          return {
            mysqlHost: 'h',
            mysqlPort: 3306,
            mysqlUser: 'u',
            mysqlPassword: '',
            mysqlDatabase: 'd',
          } as unknown as ConfigService;
        }
        return undefined;
      })
      .compile();
    const svc = moduleRef.get(RouterService);
    expect(svc).toBeInstanceOf(RouterService);
    await moduleRef.close();
  });
});

/**
 * v0.6.0 whole-branch canary: compile the FULL AppModule DI graph.
 *
 * Per-task tests all use `useValue` stubs for SummarizationService, so the
 * v0.6 DI seam bug — UsageLogger exported from HandlersModule but not
 * imported into SummarizerModule — was invisible to T1–T7 reviews. The
 * real failure surfaces only when `NestFactory.create(AppModule)` actually
 * instantiates SummarizationService with its 3-arg constructor
 * (SUMMARIZER_PROVIDERS, UsageLogger, ConfigService).
 *
 * This test reproduces that production-startup path. The trick: a naive
 * `useMocker` returning `{}` for every token would MASK the bug (the
 * mocker fires after NestJS's normal DI lookup fails, and `{}` is treated
 * as a valid substitute). To make the test actually catch the missing
 * UsageLogger, we REFUSE to mock UsageLogger — if SummarizerModule can't
 * DI-resolve it through HandlersModule, NestJS re-throws the original
 * resolution error and the assertion fails.
 *
 * Without the fix: "Nest can't resolve dependencies of the
 * SummarizationService (... UsageLogger at index [1] is not available
 * in the SummarizerModule context)" at .compile() time.
 * With the fix: AppModule compiles, moduleRef is defined.
 */
describe('AppModule DI (v0.6.0 whole-branch canary)', () => {
  it('compiles the full AppModule DI graph; UsageLogger MUST be wired through DI (not mocked away)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .useMocker((token) => {
        // Refuse to mock UsageLogger — force NestJS to resolve it through
        // the real DI graph (HandlersModule → SummarizerModule). If the
        // export/import seam is broken, .compile() throws.
        if (token === UsageLogger) return undefined;
        // Auto-mock everything else (Redis pools, MySQL pools, adapters,
        // BullMQ workers, controllers) — they need real network/env which
        // a CI test cannot provide.
        return {};
      })
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
