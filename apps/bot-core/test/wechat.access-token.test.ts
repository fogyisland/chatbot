import { WeChatAdapter } from '../src/platform/wechat/wechat.adapter';

describe('WeChatAdapter.fetchAccessToken', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(responder: (url: string) => Promise<any>) {
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      calls.push(u);
      return responder(u);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('first call hits the API and caches the token with TTL', async () => {
    let now = 1_000_000;
    const { fetchImpl, calls } = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 0, access_token: 'T1', expires_in: 7200 }),
    }));
    const a = new WeChatAdapter('tok', {
      apiBase: 'https://example.test',
      corpId: 'corp',
      corpSecret: 'secret',
      fetchImpl,
      now: () => now,
    });
    const t = await a.fetchAccessToken();
    expect(t).toBe('T1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/cgi-bin/gettoken');
    expect(calls[0]).toContain('corpid=corp');
    expect(calls[0]).toContain('corpsecret=secret');
    const cached = a.getCachedAccessToken();
    expect(cached?.token).toBe('T1');
    expect(cached?.expiresAt).toBe(now + 7200 * 1000);
  });

  it('second call within TTL uses cache (no extra API hit)', async () => {
    let now = 1_000_000;
    const { fetchImpl, calls } = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 0, access_token: 'T2', expires_in: 7200 }),
    }));
    const a = new WeChatAdapter('tok', {
      apiBase: 'https://example.test',
      corpId: 'c', corpSecret: 's',
      fetchImpl,
      now: () => now,
    });
    await a.fetchAccessToken();
    await a.fetchAccessToken();
    await a.fetchAccessToken();
    expect(calls).toHaveLength(1);
    // advance well within TTL (expiresAt - 1ms)
    now += 7000 * 1000;
    await a.fetchAccessToken();
    expect(calls).toHaveLength(1);
  });

  it('sendReply retries once with a refreshed token on 40001', async () => {
    let now = 2_000_000;
    let sendCallCount = 0;
    let gettokenCallCount = 0;
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/cgi-bin/gettoken')) {
        gettokenCallCount++;
        return { ok: true, status: 200, json: async () => ({ errcode: 0, access_token: 'FRESH', expires_in: 7200 }) };
      }
      sendCallCount++;
      if (sendCallCount === 1) {
        return { ok: true, status: 200, json: async () => ({ errcode: 40001, errmsg: 'invalid credential' }) };
      }
      return { ok: true, status: 200, json: async () => ({ errcode: 0 }) };
    }) as unknown as typeof fetch;
    const a = new WeChatAdapter('tok', {
      apiBase: 'https://example.test',
      corpId: 'c', corpSecret: 's',
      fetchImpl,
      now: () => now,
    });
    const r = await a.sendReply({ text: 'hi' }, { chatId: 'u', chatType: 'direct' });
    expect(r.ok).toBe(true);
    expect(sendCallCount).toBe(2);
    const sends = calls.filter((c) => c.includes('/cgi-bin/message/custom/send'));
    expect(sends).toHaveLength(2);
    // Second send must include the freshly-fetched token.
    expect(sends[1]).toContain('access_token=FRESH');
    // Should have fetched token once at first send (returned FRESH), then again on retry because cache was dropped.
    expect(gettokenCallCount).toBe(2);
  });

  it('sendReply fails closed when token API is unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const a = new WeChatAdapter('tok', {
      apiBase: 'https://example.test',
      corpId: 'c', corpSecret: 's',
      fetchImpl,
    });
    const r = await a.sendReply({ text: 'hi' }, { chatId: 'u', chatType: 'direct' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('network');
  });
});