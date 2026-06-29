import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

@Module({
  controllers: [AdminController],
  providers: [
    {
      provide: AdminGuard,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => new AdminGuard({
        adminApiToken: process.env.ADMIN_API_TOKEN ?? 'dev-token-change-me',
      }),
    },
  ],
})
export class AdminApiModule {}