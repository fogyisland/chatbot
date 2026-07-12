import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { SummarizerModule } from '../handlers/summarizer/summarizer.module';
import { MessagesModule } from '../messages/messages.module';

@Module({
  imports: [SummarizerModule, MessagesModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
