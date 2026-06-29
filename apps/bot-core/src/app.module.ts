import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { HealthController } from './webhook/health.controller';

@Module({
  imports: [ConfigModule, LoggerModule],
  controllers: [HealthController],
})
export class AppModule {}