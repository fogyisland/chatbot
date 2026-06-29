import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { HealthController } from './webhook/health.controller';
import { PlatformModule } from './platform/platform.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [ConfigModule, LoggerModule, PlatformModule, QueueModule],
  controllers: [HealthController],
})
export class AppModule {}