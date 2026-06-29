import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly opts: { adminApiToken: string }) {}

  canActivate(ctx: ExecutionContext): boolean {
    const headers: Record<string, string | string[] | undefined> =
      typeof ctx.switchToHttp === 'function'
        ? ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers
        : (ctx as unknown as { headers: Record<string, string | string[] | undefined> }).headers;
    const auth = headers?.authorization;
    if (!auth || typeof auth !== 'string') throw new UnauthorizedException('missing auth');
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== this.opts.adminApiToken) throw new UnauthorizedException('invalid token');
    return true;
  }
}