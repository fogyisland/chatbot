import { TeamsAdapter } from '../src/platform/teams/teams.adapter';

describe('TeamsAdapter', () => {
  it('verifySignature accepts Bot Framework JWT (stubbed true)', () => {
    const a = new TeamsAdapter({ appId: 'app', appSecret: 'sec' });
    expect(a.verifySignature({ headers: {}, body: {}, query: {} })).toBe(true);
  });

  it('parseInbound maps activity to NormalizedMessage', async () => {
    const a = new TeamsAdapter({ appId: 'app', appSecret: 'sec' });
    const m = await a.parseInbound({
      headers: {}, query: {},
      body: {
        id: 'msg-1',
        conversation: { id: 'conv-1', conversationType: 'channel' },
        from: { id: 'user-1', name: 'Bob' },
        text: 'hello teams',
        recipient: {},
        timestamp: new Date().toISOString(),
      },
    } as any);
    expect(m.platform).toBe('teams');
    expect(m.text).toBe('hello teams');
    expect(m.chatId).toBe('conv-1');
    expect(m.senderName).toBe('Bob');
  });
});
