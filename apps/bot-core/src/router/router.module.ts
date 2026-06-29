import { Module, Global } from '@nestjs/common';
import { RouterService } from './router.service';

@Global()
@Module({
  providers: [
    {
      provide: RouterService,
      useFactory: () => new RouterService({
        commands: { help: 'help', clear: 'clear', status: 'status' },
        prefixes: { kb: 'kb', tool: 'tool', ask: 'llm' },
        defaultHandler: 'llm',
        commandOnly: false,
      }),
    },
  ],
  exports: [RouterService],
})
export class RouterModule {}
