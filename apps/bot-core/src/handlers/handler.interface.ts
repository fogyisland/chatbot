import { Injectable } from '@nestjs/common';
import { NormalizedReply } from '@mpcb/shared';

export interface HandlerContext {
  userId: string;
  chatId: string;
  platform: 'wechat' | 'teams' | 'dingtalk';
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  abortSignal: AbortSignal;
}

export interface Handler {
  readonly name: string;
  handle(input: any, ctx: HandlerContext): Promise<NormalizedReply>;
}

@Injectable()
export class HandlerRegistry {
  private readonly map = new Map<string, Handler>();

  register(h: Handler) { this.map.set(h.name, h); }
  get(name: string): Handler | undefined { return this.map.get(name); }
  list(): Handler[] { return [...this.map.values()]; }
}