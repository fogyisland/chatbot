import { AdminGuard } from '../src/admin-api/admin.guard';

describe('AdminGuard', () => {
  const make = (token: string | undefined) =>
    new AdminGuard({ adminApiToken: token ?? '' });

  it('allows request with matching token', () => {
    const g = make('secret');
    expect(g.canActivate({ headers: { authorization: 'Bearer secret' } } as any)).toBe(true);
  });

  it('rejects request without token', () => {
    const g = make('secret');
    expect(() => g.canActivate({ headers: {} } as any)).toThrow();
  });

  it('rejects request with wrong token', () => {
    const g = make('secret');
    expect(() => g.canActivate({ headers: { authorization: 'Bearer wrong' } } as any)).toThrow();
  });
});