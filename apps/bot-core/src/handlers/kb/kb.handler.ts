import { Injectable, Logger } from '@nestjs/common';
import { NormalizedReply, RouteDecision } from '@mpcb/shared';
import { Handler, HandlerContext } from '../handler.interface';
import { LlmProvider, ChatRequest } from '../llm/llm.types';
import { QdrantKbClient } from './qdrant.client';
import { Embedder } from './embedder';

export interface KbHandlerDeps {
  qdrant: QdrantKbClient;
  embedder: Embedder;
  llm: LlmProvider;
  topK?: number;
}

const SYSTEM_PROMPT = `你是企业知识库助手。请仅基于提供的上下文回答问题。
如果上下文不足以回答问题,请直接说"未找到相关信息"。不要编造。`;

@Injectable()
export class KbHandler implements Handler {
  readonly name = 'kb';
  private readonly logger = new Logger(KbHandler.name);
  private readonly topK: number;

  constructor(private readonly deps: KbHandlerDeps) {
    this.topK = deps.topK ?? 10;
  }

  async handle(input: RouteDecision & { kind: 'kb' }, ctx: HandlerContext): Promise<NormalizedReply> {
    const k = input.topK ?? 3;
    const vectors = await this.deps.embedder.embedBatch([input.query]);
    const hits = await this.deps.qdrant.search(vectors[0], this.topK);
    const top = hits.slice(0, k);
    if (top.length === 0) {
      return { text: '未找到相关信息。' };
    }
    const context = top.map((h, i) => `[${i + 1}] ${h.payload?.doc_title ?? ''}: ${h.payload?.content_preview ?? ''}`).join('\n');
    const req: ChatRequest = {
      model: this.deps.llm.defaultModel,
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `上下文:\n${context}\n\n问题:${input.query}` },
      ],
    };
    try {
      const resp = await this.deps.llm.chat(req);
      return { text: resp.text };
    } catch (err) {
      this.logger.error(`KB LLM error: ${err}`);
      return { text: '抱歉,生成回复时出错。' };
    }
  }
}
