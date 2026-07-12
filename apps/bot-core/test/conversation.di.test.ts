import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '../src/common/config/config.service';
import { ConversationService } from '../src/conversation/conversation.service';
import { SummarizationService } from '../src/handlers/summarizer/summarizer.service';
import { MessageLogService } from '../src/messages/message-log.service';

describe('ConversationService DI (v0.6 canary)', () => {
  it('constructs via Nest Test module with the new 3-arg constructor', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigService,
        // Provide stubs for the new deps so we don't pull in real LLM providers here.
        {
          provide: SummarizationService,
          useValue: {
            summarize: async () => '',
            contextWindow: 100_000,
          },
        },
        {
          provide: MessageLogService,
          useValue: {
            upsertSummary: async () => undefined,
          },
        },
        ConversationService,
      ],
    }).compile();

    const svc = moduleRef.get(ConversationService);
    expect(svc).toBeInstanceOf(ConversationService);

    // Verify the new 3-arg constructor took effect (cf. v0.4/v0.5 1-arg ctor).
    expect(svc.constructor.length).toBe(3);

    await moduleRef.close();
  });
});
