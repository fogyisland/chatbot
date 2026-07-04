import { Module } from '@nestjs/common';
import { ConfigModule } from '../common/config/config.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [ConfigModule],
  controllers: [AdminController],
  providers: [AdminGuard],
})
export class AdminApiModule {}