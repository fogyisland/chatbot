import { Worker, Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { createPool, Pool } from 'mysql2/promise';
import { MESSAGE_QUEUE, DLQ_NAME } from './queue.service';
import { ConfigService } from '../common/config/config.service';
import { MessageProcessor } from './message.processor';
import { NormalizedMessage } from '@mpcb/shared';

export interface WorkerDeps {
  cfg: ConfigService;
  processor: MessageProcessor;
  dlq: Queue;
  pool: Pool;
}

export function createWorker(deps: WorkerDeps): Worker {
  const { cfg, processor, dlq, pool } = deps;
  const logger = new Logger('Worker');

  const worker = new Worker<NormalizedMessage>(
    MESSAGE_QUEUE,
    async (job: Job<NormalizedMessage>) => {
      const msg = job.data;
      logger.debug(`processing msg=${msg.msgId} platform=${msg.platform}`);

      // Idempotency guard: BullMQ jobId=msgId prevents duplicate enqueue,
      // but double-check before sending replies.
      const result = await processor.process(msg);
      return {
        replied: result.sent,
        text: result.reply.text,
        target: result.target,
        sendError: result.sendError,
      };
    },
    {
      connection: { host: cfg.redisHost, port: cfg.redisPort },
      concurrency: 10,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // not exhausted yet

    logger.error(`msg=${job.id} exhausted retries → DLQ: ${err.message}`);

    // Persist to dlq_records so the admin DLQ page can list/replay.
    try {
      await pool.query(
        `INSERT INTO dlq_records (job_id, payload_json, error_message, retries, created_at)
         VALUES (?, ?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE
           payload_json = VALUES(payload_json),
           error_message = VALUES(error_message),
           retries = VALUES(retries),
           created_at = VALUES(created_at)`,
        [
          String(job.id ?? ''),
          JSON.stringify(job.data ?? {}),
          String(err?.message ?? '').slice(0, 1024),
          job.attemptsMade,
        ],
      );
    } catch (dbErr) {
      logger.error(
        `dlq_records insert failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }

    // Also enqueue on the DLQ BullMQ queue for downstream consumers.
    try {
      await dlq.add(
        DLQ_NAME,
        { jobId: job.id, payload: job.data, error: err?.message ?? '', retries: job.attemptsMade },
        { removeOnComplete: false, removeOnFail: false },
      );
    } catch (qErr) {
      logger.error(
        `DLQ_INSTANCE add failed: ${qErr instanceof Error ? qErr.message : String(qErr)}`,
      );
    }
  });

  return worker;
}