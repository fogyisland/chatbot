import { Injectable, Logger } from '@nestjs/common';
import { NormalizedReply, RouteDecision } from '@mpcb/shared';
import { Handler, HandlerContext } from '../handler.interface';

export interface ToolDef<TArgs = any> {
  name: string;
  description: string;
  rateLimit: number; // per-user per-minute
  enabled: boolean;
  execute(args: TArgs, ctx: HandlerContext): Promise<NormalizedReply>;
}

interface RateCounter { count: number; resetAt: number }

@Injectable()
export class ToolRegistry implements Handler {
  readonly name = 'tool';
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, ToolDef>();
  private readonly rateCounters = new Map<string, RateCounter>();

  register(t: ToolDef): void { this.tools.set(t.name, t); }
  list(): ToolDef[] { return [...this.tools.values()]; }

  private checkRate(toolName: string, userId: string, limit: number): boolean {
    const key = `${userId}:${toolName}`;
    const now = Date.now();
    const c = this.rateCounters.get(key);
    if (!c || c.resetAt < now) {
      this.rateCounters.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (c.count >= limit) return false;
    c.count++;
    return true;
  }

  async execute(name: string, args: string, ctx: HandlerContext): Promise<NormalizedReply> {
    const tool = this.tools.get(name);
    if (!tool || !tool.enabled) return { text: `工具 ${name} 不存在或已禁用。` };
    if (!this.checkRate(name, ctx.userId, tool.rateLimit)) {
      return { text: `工具 ${name} 调用频率超限,请稍后再试。` };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      this.logger.error(`tool ${name} error: ${err}`);
      return { text: `工具执行失败:${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async handle(input: RouteDecision & { kind: 'tool' }, ctx: HandlerContext): Promise<NormalizedReply> {
    return this.execute(input.toolName, input.args, ctx);
  }
}
