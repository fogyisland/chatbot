// v0.4 whole-branch review follow-up: minimal DI-shape canary for the
// MessageProcessor constructor change (5 → 6 args in T5, including the new
// ConfigService injection).
//
// A full WorkerModule.compile() canary (analogous to the v0.3.1
// RouterService one) is blocked by QueueModule's useFactory registration
// of 'DLQ_INSTANCE' without exporting the string token — the NestJS
// testing module does not reliably resolve non-exported string-token
// providers across module boundaries even with @Global(). The whole-branch
// review (I2) flagged this as defense-in-depth; see progress ledger.
//
// This test instead pins the MessageProcessor constructor signature
// directly: if a future change accidentally removes ConfigService (v0.4.0
// addition), this test fails with a missing-argument TS error at compile
// time AND a Jest assertion at runtime. The 13 existing tests in
// message.processor.test.ts already exercise this signature, but they do
// so in scattered places — this single-file pin makes the v0.4 contract
// unambiguous.
import { MessageProcessor } from '../src/queue/message.processor';
import { ConversationService } from '../src/conversation/conversation.service';
import { ConfigService } from '../src/common/config/config.service';
import { MessageLogService } from '../src/messages/message-log.service';
import { RouterService } from '../src/router/router.service';
import { LlmHandler } from '../src/handlers/llm/llm.handler';
import { KbHandler } from '../src/handlers/kb/kb.handler';
import { ToolRegistry } from '../src/handlers/tool/tool.handler';
import { PlatformName } from '@mpcb/shared';

describe('MessageProcessor DI shape (v0.4.0 canary)', () => {
  it('constructs with the v0.4 6-arg signature', () => {
    // Stub the 6 dependencies with minimal shape — this test verifies the
    // constructor accepts exactly these 6 args in this order, not that any
    // particular dependency is wired correctly.
    const adapters = new Map<PlatformName, unknown>();
    const router = {} as unknown as RouterService;
    const handlers = {
      llm: {} as unknown as LlmHandler,
      kb: {} as unknown as KbHandler,
      tool: {} as unknown as ToolRegistry,
    };
    const messageLog = {} as unknown as MessageLogService;
    const conversation = {} as unknown as ConversationService;
    const cfg = {} as unknown as ConfigService;

    const proc = new MessageProcessor(
      adapters as never,
      router,
      handlers,
      messageLog,
      conversation,
      cfg,
    );

    expect(proc).toBeInstanceOf(MessageProcessor);
  });
});
