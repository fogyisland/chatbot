import { Module, Global } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QueueService, MESSAGE_QUEUE, DLQ_NAME } from './queue.service';
import { ConfigService } from '../common/config/config.service';

@Global()
@Module({
  providers: [
    {
      provide: 'MESSAGE_QUEUE_INSTANCE',
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const connection = { host: cfg.redisHost, port: cfg.redisPort };
        return new Queue(MESSAGE_QUEUE, { connection });
      },
    },
    {
      provide: 'DLQ_INSTANCE',
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const connection = { host: cfg.redisHost, port: cfg.redisPort };
        return new Queue(DLQ_NAME, { connection });
      },
    },
    QueueService,
  ],
  exports: [QueueService],
})
export class QueueModule {}
