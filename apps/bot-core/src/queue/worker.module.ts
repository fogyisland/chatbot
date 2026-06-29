import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import { QueueModule } from './queue.module';
import { HandlersModule } from '../handlers/handlers.module';
import { RouterModule } from '../router/router.module';
import { PlatformModule } from '../platform/platform.module';
import { ConfigService } from '../common/config/config.service';
import { MessageProcessor } from './message.processor';
import { RouterService } from '../router/router.service';
import { LlmHandler } from '../handlers/llm/llm.handler';
import { KbHandler } from '../handlers/kb/kb.handler';
import { ToolRegistry } from '../handlers/tool/tool.handler';
import { createWorker } from './worker';
import { WeChatAdapter } from '../platform/wechat/wechat.adapter';

@Module({
  imports: [QueueModule, HandlersModule, RouterModule, PlatformModule],
})
export class WorkerModule implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly router: RouterService,
    private readonly llm: LlmHandler,
    private readonly kb: KbHandler,
    private readonly tool: ToolRegistry,
    private readonly wechat: WeChatAdapter,
  ) {}

  onModuleInit() {
    const processor = new MessageProcessor(this.wechat, this.router, { llm: this.llm, kb: this.kb, tool: this.tool });
    this.worker = createWorker(this.cfg, processor);
  }

  async onModuleDestroy() {
    if (this.worker) await this.worker.close();
  }
}