import { AdminGuard } from '../src/admin-api/admin.guard';
import { ConfigService } from '../src/common/config/config.service';

function makeCfg(env: Record<string, string | undefined>): ConfigService {
  const cfg = new ConfigService();
  // Override the getters to read from a controlled bag rather than process.env.
  Object.defineProperty(cfg, 'nodeEnv', { get: () => env.NODE_ENV ?? 'development' });
  Object.defineProperty(cfg, 'adminApiToken', { get: () => env.ADMIN_API_TOKEN ?? '' });
  return cfg;
}

describe('AdminGuard', () => {
  it('allows request with matching token', () => {
    const g = new AdminGuard(makeCfg({ ADMIN_API_TOKEN: 'secret' }));
    expect(g.canActivate({ headers: { authorization: 'Bearer secret' } } as any)).toBe(true);
  });

  it('rejects request without token', () => {
    const g = new AdminGuard(makeCfg({ ADMIN_API_TOKEN: 'secret' }));
    expect(() => g.canActivate({ headers: {} } as any)).toThrow();
  });

  it('rejects request with wrong token', () => {
    const g = new AdminGuard(makeCfg({ ADMIN_API_TOKEN: 'secret' }));
    expect(() => g.canActivate({ headers: { authorization: 'Bearer wrong' } } as any)).toThrow();
  });

  it('production without token fails closed (503)', () => {
    const g = new AdminGuard(makeCfg({ NODE_ENV: 'production', ADMIN_API_TOKEN: undefined }));
    // Even with a valid-looking Authorization header, prod-without-token must reject.
    expect(() => g.canActivate({ headers: { authorization: 'Bearer dev-token-change-me' } } as any))
      .toThrow(/admin api token not configured/i);
  });

  it('development without token uses dev fallback', () => {
    const g = new AdminGuard(makeCfg({ NODE_ENV: 'development', ADMIN_API_TOKEN: undefined }));
    // Dev fallback is 'dev-token-change-me' — must accept that exact bearer.
    expect(g.canActivate({ headers: { authorization: 'Bearer dev-token-change-me' } } as any)).toBe(true);
  });

  it('test NODE_ENV without token also uses dev fallback', () => {
    const g = new AdminGuard(makeCfg({ NODE_ENV: 'test', ADMIN_API_TOKEN: undefined }));
    expect(g.canActivate({ headers: { authorization: 'Bearer dev-token-change-me' } } as any)).toBe(true);
  });
});