import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';
import { NormalizedMessage } from '@mpcb/shared';

export const MESSAGE_QUEUE = 'message.process';
export const DLQ_NAME = 'message.dlq';

export const MESSAGE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: false,
};

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(@Inject('MESSAGE_QUEUE_INSTANCE') private readonly queue: Queue) {}

  async enqueueMessage(msg: NormalizedMessage): Promise<void> {
    const job = await this.queue.add(MESSAGE_QUEUE, msg, {
      ...MESSAGE_JOB_OPTIONS,
      jobId: msg.msgId,
    });
    this.logger.debug(`enqueued msg=${msg.msgId} jobId=${job.id}`);
  }

  getQueue(): Queue {
    return this.queue;
  }
}
