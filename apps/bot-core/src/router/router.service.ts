import { Injectable, Logger } from '@nestjs/common';
import { RouteDecision } from '@mpcb/shared';
import { NormalizedMessage } from '@mpcb/shared';
import { RouteContext, RouterConfig } from './router.types';
import { RouterConfigStore } from './router-config.store';

const DEFAULT_CONFIG: RouterConfig = {
  commands: { help: 'help', clear: 'clear', status: 'status', forget: 'forget' },
  prefixes: { kb: 'kb', tool: 'tool', ask: 'llm' },
  defaultHandler: 'llm',
  commandOnly: false,
  forgetReply: 'verbose',
};

type ConfigSource = RouterConfigStore | RouterConfig | { getConfig: () => Promise<RouterConfig> };

const CACHE_TTL_MS = 60_000;

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);
  private cache: { value: RouterConfig; expiresAt: number } | null = null;

  /**
   * Three construction modes:
   *  - RouterConfigStore: own pool, hits MySQL via the store; we cache
   *    the result for 60s on top of the store's own cache.
   *  - Object exposing getConfig() (e.g. test mock, future Redis-backed
   *    source): same caching + fallback behavior.
   *  - Plain RouterConfig (unit tests): cached like the others but
   *    loaded synchronously.
   */
  constructor(private readonly source: ConfigSource) {}

  /** Test-only: force re-load on next route(). */
  invalidate(): void {
    this.cache = null;
  }

  /** Returns the current (cached) RouterConfig. Used by MessageProcessor to read forgetReply. */
  async getConfig(): Promise<RouterConfig> {
    return this.loadConfig();
  }

  async route(msg: NormalizedMessage, _ctx: RouteContext): Promise<RouteDecision> {
    const config = await this.loadConfig();
    const text = (msg.text || '').trim();

    // 1. Built-in commands: /cmd args
    if (text.startsWith('/')) {
      const rest = text.slice(1).trim();
      const [cmd, ...argParts] = rest.split(/\s+/);
      const handler = config.commands[cmd.toLowerCase()];
      if (handler) {
        return { kind: 'command', handler, args: argParts.join(' ') };
      }
      return { kind: 'unknown', reason: `unknown_command:${cmd}` };
    }

    // 2. Prefixes: kb: query, tool: name args, ask: prompt
    for (const [prefix, target] of Object.entries(config.prefixes)) {
      const m = text.match(new RegExp(`^${prefix}\\s*:\\s*(.+)$`, 'i'));
      if (m) {
        const payload = m[1].trim();
        if (target === 'kb') return { kind: 'kb', query: payload };
        if (target === 'tool') {
          const [toolName, ...args] = payload.split(/\s+/);
          return { kind: 'tool', toolName, args: args.join(' ') };
        }
        if (target === 'llm') return { kind: 'llm', prompt: payload };
      }
    }

    // 3. Default handler (or unknown if commandOnly)
    if (config.commandOnly) return { kind: 'unknown', reason: 'plain_text_in_command_only_mode' };
    return { kind: 'llm', prompt: text };
  }

  private async loadConfig(): Promise<RouterConfig> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    let cfg: RouterConfig | null = null;
    try {
      cfg = await this.fetch();
    } catch (err) {
      this.logger.warn(
        `router config load failed (${err instanceof Error ? err.message : String(err)}); using defaults`,
      );
      cfg = DEFAULT_CONFIG;
    }
    // Cache for the full TTL even on fallback so a flapping MySQL doesn't
    // hammer the database. invalidate() forces a refresh after admin edits.
    this.cache = { value: cfg, expiresAt: now + CACHE_TTL_MS };
    return cfg;
  }

  private async fetch(): Promise<RouterConfig> {
    if (this.source instanceof RouterConfigStore) {
      return this.source.getConfig();
    }
    if (this.source && typeof (this.source as { getConfig?: unknown }).getConfig === 'function') {
      return (this.source as { getConfig: () => Promise<RouterConfig> }).getConfig();
    }
    return (this.source as RouterConfig) ?? DEFAULT_CONFIG;
  }
}
