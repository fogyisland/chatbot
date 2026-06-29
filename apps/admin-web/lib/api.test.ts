import { createApiClient } from '../lib/api';

describe('ApiClient', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('listMessages includes token and forwards params', async () => {
    let captured: any = null;
    global.fetch = async (url: any, init: any) => {
      captured = { url: String(url), init };
      return { ok: true, status: 200, json: async () => ([]) } as any;
    };
    const c = createApiClient('https://bot.example.com', 'tok');
    await c.listMessages({ platform: 'wechat', limit: 10 });
    expect(captured.url).toContain('/admin/messages');
    expect(captured.init.headers.Authorization).toBe('Bearer tok');
    expect(captured.url).toContain('platform=wechat');
    expect(captured.url).toContain('limit=10');
  });
});