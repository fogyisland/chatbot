import { Worker, Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { MESSAGE_QUEUE } from './queue.service';
import { ConfigService } from '../common/config/config.service';
import { MessageProcessor } from './message.processor';
import { NormalizedMessage } from '@mpcb/shared';

export function createWorker(cfg: ConfigService, processor: MessageProcessor): Worker {
  const worker = new Worker<NormalizedMessage>(
    MESSAGE_QUEUE,
    async (job: Job<NormalizedMessage>) => {
      const msg = job.data;
      const logger = new Logger('Worker');
      logger.debug(`processing msg=${msg.msgId} platform=${msg.platform}`);

      // Idempotency guard: BullMQ jobId=msgId prevents duplicate enqueue,
      // but double-check before sending replies.
      const { reply, target } = await processor.process(msg);
      // Adapter lookup deferred — processor currently uses single default adapter.
      // Real wiring: route to platform-specific adapter by msg.platform.
      return { replied: true, text: reply.text, target };
    },
    {
      connection: { host: cfg.redisHost, port: cfg.redisPort },
      concurrency: 10,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      // Move to DLQ (in real impl, also persist to dlq_records table).
      const logger = new Logger('Worker');
      logger.error(`msg=${job.id} exhausted retries → DLQ: ${err.message}`);
    }
  });

  return worker;
}