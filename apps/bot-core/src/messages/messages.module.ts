import { Global, Module } from '@nestjs/common';
import { MessageLogService } from './message-log.service';

@Global()
@Module({
  providers: [MessageLogService],
  exports: [MessageLogService],
})
export class MessagesModule {}