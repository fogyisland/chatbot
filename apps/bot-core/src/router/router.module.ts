import { Module, Global } from '@nestjs/common';
import { RouterService } from './router.service';
import { RouterConfigStore } from './router-config.store';

@Global()
@Module({
  providers: [
    RouterConfigStore,
    {
      provide: RouterService,
      inject: [RouterConfigStore],
      useFactory: (store: RouterConfigStore) => new RouterService(store),
    },
  ],
  exports: [RouterService, RouterConfigStore],
})
export class RouterModule {}
