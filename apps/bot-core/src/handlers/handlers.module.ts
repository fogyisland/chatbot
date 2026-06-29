import { Module } from '@nestjs/common';
import { HandlerRegistry } from './handler.interface';
import { LlmHandler } from './llm/llm.handler';
import { ClaudeProvider } from './llm/providers/claude.provider';

@Module({
  providers: [HandlerRegistry, ClaudeProvider, LlmHandler],
  exports: [HandlerRegistry, LlmHandler],
})
export class HandlersModule {}