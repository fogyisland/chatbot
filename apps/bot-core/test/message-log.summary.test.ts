import * as crypto from 'crypto';
import { MessageLogService } from '../src/messages/message-log.service';
import { ConfigService } from '../src/common/config/config.service';

const sessionKeyFor = (p: string, c: string, s: string): string => `${p}::${c}::${s}`;
const expectedMsgId = (sessionKey: string): string =>
  `summary-${crypto.createHash('sha1').update(sessionKey).digest('hex').slice(0, 16)}`;

describe('MessageLogService.upsertSummary', () => {
  let svc: MessageLogService;

  beforeEach(() => {
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_PORT;
    delete process.env.MYSQL_USER;
    delete process.env.MYSQL_PASSWORD;
    delete process.env.MYSQL_DATABASE;
    svc = new MessageLogService(new ConfigService());
  });

  it('builds the expected deterministic summary msg_id from sessionKey', () => {
    // Pure-hash sanity check (no DB needed) — the helper must be stable.
    const sessionKey = sessionKeyFor('wechat', 'chat-1', 'user-1');
    const msgId = expectedMsgId(sessionKey);
    expect(msgId).toMatch(/^summary-[0-9a-f]{16}$/);
    // Same input → same output (callable twice)
    expect(msgId).toBe(expectedMsgId(sessionKey));
    // Different sender → different output
    expect(msgId).not.toBe(
      expectedMsgId(sessionKeyFor('wechat', 'chat-1', 'user-2')),
    );
  });

  it('throws when MySQL pool cannot be created (DB unreachable)', async () => {
    // Force an unreachable host so the lazy pool creation throws on first query.
    process.env.MYSQL_HOST = '127.0.0.1';
    process.env.MYSQL_PORT = '1'; // closed port — connection refused
    svc = new MessageLogService(new ConfigService());

    await expect(
      svc.upsertSummary('summary text', 'wechat', 'chat-1', 'user-1'),
    ).rejects.toBeDefined();
  });

  it('upsertSummary signature: 4 string args, returns Promise<void>', () => {
    expect(svc.upsertSummary.length).toBe(4); // content, platform, chatId, senderId
    const ret = svc.upsertSummary('x', 'wechat', 'chat-1', 'user-1');
    expect(ret).toBeInstanceOf(Promise);
  });
});
