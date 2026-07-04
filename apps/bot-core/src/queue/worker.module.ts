import { Module, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { Worker } from 'bullmq';
import { Queue } from 'bullmq';
import { createPool, Pool } from 'mysql2/promise';
import { QueueModule } from './queue.module';
import { HandlersModule } from '../handlers/handlers.module';
import { RouterModule } from '../router/router.module';
import { PlatformModule, buildAdapterMap } from '../platform/platform.module';
import { ConfigService } from '../common/config/config.service';
import { MessageProcessor } from './message.processor';
import { RouterService } from '../router/router.service';
import { LlmHandler } from '../handlers/llm/llm.handler';
import { KbHandler } from '../handlers/kb/kb.handler';
import { ToolRegistry } from '../handlers/tool/tool.handler';
import { createWorker } from './worker';
import { MessageLogService } from '../messages/message-log.service';
import { MessagesModule } from '../messages/messages.module';
import { PlatformAdapter, PLATFORM_ADAPTER } from '../platform/platform-adapter.interface';
import { ConversationModule } from '../conversation/conversation.module';
import { ConversationService } from '../conversation/conversation.service';

@Module({
  imports: [QueueModule, HandlersModule, RouterModule, PlatformModule, MessagesModule, ConversationModule],
})
export class WorkerModule implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;
  private pool: Pool | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly router: RouterService,
    private readonly llm: LlmHandler,
    private readonly kb: KbHandler,
    private readonly tool: ToolRegistry,
    @Inject(PLATFORM_ADAPTER) private readonly adapters: PlatformAdapter[],
    @Inject('DLQ_INSTANCE') private readonly dlq: Queue,
    private readonly messageLog: MessageLogService,
    private readonly conversation: ConversationService,
  ) {}

  onModuleInit() {
    const adapterMap = buildAdapterMap(this.adapters);
    const processor = new MessageProcessor(
      adapterMap,
      this.router,
      { llm: this.llm, kb: this.kb, tool: this.tool },
      this.messageLog,
      this.conversation,
    );

    this.pool = createPool({
      host: this.cfg.mysqlHost,
      port: this.cfg.mysqlPort,
      user: this.cfg.mysqlUser,
      password: this.cfg.mysqlPassword,
      database: this.cfg.mysqlDatabase,
      connectionLimit: 5,
    });

    this.worker = createWorker({
      cfg: this.cfg,
      processor,
      dlq: this.dlq,
      pool: this.pool,
    });
  }

  async onModuleDestroy() {
    if (this.worker) await this.worker.close();
    if (this.pool) await this.pool.end();
    await this.messageLog.close();
  }
}