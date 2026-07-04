import { WeChatAdapter } from '../src/platform/wechat/wechat.adapter';

describe('WeChatAdapter.sendReply', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts to /cgi-bin/message/custom/send with correct payload', async () => {
    const calls: any[] = [];
    global.fetch = async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ errcode: 0 }) } as any;
    };
    const a = new WeChatAdapter('tok', {
      accessToken: 'AT',
      apiBase: 'https://example.test',
      corpId: 'c',
      corpSecret: 's',
    });
    const r = await a.sendReply({ text: 'hi' }, { chatId: 'user_1', chatType: 'direct' });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/cgi-bin/message/custom/send');
    const body = JSON.parse(calls[0].init.body);
    expect(body.touser).toBe('user_1');
    expect(body.text.content).toBe('hi');
  });

  it('returns ok=false on non-zero errcode', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ errcode: 40001 }) } as any);
    const a = new WeChatAdapter('tok', {
      accessToken: 'AT',
      apiBase: 'https://example.test',
      corpId: 'c',
      corpSecret: 's',
    });
    const r = await a.sendReply({ text: 'hi' }, { chatId: 'u', chatType: 'direct' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('40001');
  });
});