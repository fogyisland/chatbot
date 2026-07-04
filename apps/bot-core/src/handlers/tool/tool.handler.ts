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

/** When the map exceeds this many entries, sweep all expired counters. */
const PRUNE_THRESHOLD = 10_000;

@Injectable()
export class ToolRegistry implements Handler {
  readonly name = 'tool';
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, ToolDef>();
  private readonly rateCounters = new Map<string, RateCounter>();

  register(t: ToolDef): void { this.tools.set(t.name, t); }
  list(): ToolDef[] { return [...this.tools.values()]; }

  /**
   * Cap the rate-counter map so it can't grow without bound under churn.
   * Called from checkRate(); the work is gated behind PRUNE_THRESHOLD so the
   * hot path stays cheap.
   *
   * Strategy: (1) drop every entry whose window has elapsed, then (2) if the
   * map is still above the threshold (e.g. a burst of distinct users all
   * landing in the same fresh window), evict the entry with the earliest
   * `resetAt`. This guarantees size stays O(threshold) even under attack.
   */
  private pruneExpired(now: number): void {
    if (this.rateCounters.size < PRUNE_THRESHOLD) return;
    for (const [k, v] of this.rateCounters) {
      if (v.resetAt <= now) this.rateCounters.delete(k);
    }
    while (this.rateCounters.size >= PRUNE_THRESHOLD) {
      let oldestKey: string | null = null;
      let oldestReset = Infinity;
      for (const [k, v] of this.rateCounters) {
        if (v.resetAt < oldestReset) {
          oldestReset = v.resetAt;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      this.rateCounters.delete(oldestKey);
    }
  }

  private checkRate(toolName: string, userId: string, limit: number): boolean {
    const key = `${userId}:${toolName}`;
    const now = Date.now();
    this.pruneExpired(now);
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
