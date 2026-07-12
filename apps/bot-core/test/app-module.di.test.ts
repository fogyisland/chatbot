import { Test } from '@nestjs/testing';
import { RouterModule } from '../src/router/router.module';
import { RouterService } from '../src/router/router.service';
import { ConfigService } from '../src/common/config/config.service';

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
