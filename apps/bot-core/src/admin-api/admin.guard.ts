import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';

const DEV_FALLBACK_TOKEN = 'dev-token-change-me';

/**
 * Guards the /admin/* API. Reads the expected bearer token from
 * ConfigService (which itself reads ADMIN_API_TOKEN from the environment).
 *
 * Production posture: if NODE_ENV === 'production' and no token is
 * configured, every request fails closed with 503 — better to refuse all
 * admin traffic than to silently allow anyone past.
 *
 * Development posture: a hard-coded 'dev-token-change-me' fallback lets the
 * service start locally without ceremony, with a startup WARN so it shows
 * up in the boot logs.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);
  private readonly adminApiToken: string;
  private readonly failClosed: boolean;

  constructor(cfg: ConfigService) {
    const token = cfg.adminApiToken;
    if (token) {
      this.adminApiToken = token;
      this.failClosed = false;
    } else if (cfg.nodeEnv === 'production') {
      this.adminApiToken = '';
      this.failClosed = true;
      this.logger.error(
        'ADMIN_API_TOKEN is unset in production; AdminGuard is locked (all requests will fail with 503).',
      );
    } else {
      this.adminApiToken = DEV_FALLBACK_TOKEN;
      this.failClosed = false;
      this.logger.warn(
        `ADMIN_API_TOKEN is unset in non-production (NODE_ENV=${cfg.nodeEnv}); AdminGuard using dev fallback '${DEV_FALLBACK_TOKEN}'. Set ADMIN_API_TOKEN to silence this warning.`,
      );
    }
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (this.failClosed) {
      throw new ServiceUnavailableException('admin api token not configured');
    }
    const headers: Record<string, string | string[] | undefined> =
      typeof ctx.switchToHttp === 'function'
        ? ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers
        : (ctx as unknown as { headers: Record<string, string | string[] | undefined> }).headers;
    const auth = headers?.authorization;
    if (!auth || typeof auth !== 'string') throw new UnauthorizedException('missing auth');
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== this.adminApiToken) throw new UnauthorizedException('invalid token');
    return true;
  }
}