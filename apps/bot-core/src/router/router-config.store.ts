import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createPool, Pool } from 'mysql2/promise';
import { ConfigService } from '../common/config/config.service';
import { RouterConfig } from './router.types';

/**
 * Default rules used as a fallback when MySQL is unreachable or empty.
 * Mirrors the seed data in migrations/0001_init.sql so behavior matches
 * whether the rows are present or not.
 */
const DEFAULT_CONFIG: RouterConfig = {
  commands: { help: 'help', clear: 'clear', status: 'status' },
  prefixes: { kb: 'kb', tool: 'tool', ask: 'llm' },
  defaultHandler: 'llm',
  commandOnly: false,
};

const CACHE_TTL_MS = 60_000;

interface Row {
  config_key: string;
  config_value: unknown;
  enabled: boolean;
}

/**
 * Loads router_config rows from MySQL with a 60s in-memory cache.
 * Falls back to DEFAULT_CONFIG on any failure (do NOT crash — the bot
 * must start even when MySQL is briefly unavailable).
 */
@Injectable()
export class RouterConfigStore implements OnModuleInit {
  private readonly logger = new Logger(RouterConfigStore.name);
  private pool: Pool | null = null;
  private cache: { value: RouterConfig; expiresAt: number } | null = null;

  constructor(private readonly cfg: ConfigService) {}

  onModuleInit() {
    this.pool = createPool({
      host: this.cfg.mysqlHost,
      port: this.cfg.mysqlPort,
      user: this.cfg.mysqlUser,
      password: this.cfg.mysqlPassword,
      database: this.cfg.mysqlDatabase,
      connectionLimit: 2,
    });
  }

  async getConfig(): Promise<RouterConfig> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    try {
      const rows = await this.fetchRows();
      const value = this.rowsToConfig(rows);
      this.cache = { value, expiresAt: now + CACHE_TTL_MS };
      return value;
    } catch (err) {
      this.logger.warn(
        `router_config load failed (${err instanceof Error ? err.message : String(err)}); using defaults`,
      );
      // Do NOT crash. Cache the fallback for a shorter period so transient
      // MySQL outages recover quickly.
      this.cache = { value: DEFAULT_CONFIG, expiresAt: now + 10_000 };
      return DEFAULT_CONFIG;
    }
  }

  /** Test-only: clear the in-memory cache so the next getConfig() re-queries MySQL. */
  invalidate(): void {
    this.cache = null;
  }

  private async fetchRows(): Promise<Row[]> {
    const [rows] = await this.pool!.query(
      `SELECT config_key, config_value, enabled FROM router_config WHERE enabled = TRUE`,
    );
    return rows as Row[];
  }

  private rowsToConfig(rows: Row[]): RouterConfig {
    const cfg: RouterConfig = { ...DEFAULT_CONFIG };
    const byKey = new Map<string, unknown>();
    for (const r of rows) {
      // mysql2 returns JSON columns as already-parsed objects; if it's a string, parse it.
      let v: unknown = r.config_value;
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { /* leave as string */ }
      }
      byKey.set(r.config_key, v);
    }

    const commands = byKey.get('commands');
    if (commands && typeof commands === 'object') {
      cfg.commands = commands as RouterConfig['commands'];
    }
    const prefixes = byKey.get('prefixes');
    if (prefixes && typeof prefixes === 'object') {
      cfg.prefixes = prefixes as RouterConfig['prefixes'];
    }
    const defaultHandler = byKey.get('default_handler');
    if (defaultHandler && typeof defaultHandler === 'object') {
      const dh = (defaultHandler as { kind?: string }).kind;
      if (dh === 'llm' || dh === 'kb' || dh === 'tool') cfg.defaultHandler = dh;
    }
    const commandOnly = byKey.get('command_only_mode');
    if (commandOnly && typeof commandOnly === 'object') {
      cfg.commandOnly = Boolean((commandOnly as { enabled?: boolean }).enabled);
    }
    return cfg;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}