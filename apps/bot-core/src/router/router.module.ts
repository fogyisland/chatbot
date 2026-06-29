import { Module, Global } from '@nestjs/common';
import { RouterService } from './router.service';
import { RouterConfigStore } from './router-config.store';

@Global()
@Module({
  providers: [RouterConfigStore, RouterService],
  exports: [RouterService, RouterConfigStore],
})
export class RouterModule {}