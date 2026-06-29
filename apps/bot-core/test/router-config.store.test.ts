import { RouterConfigStore } from '../src/router/router-config.store';

describe('RouterConfigStore', () => {
  function makeStoreWithPool(pool: any): RouterConfigStore {
    const cfg: any = { mysqlHost: 'h', mysqlPort: 3306, mysqlUser: 'u', mysqlPassword: 'p', mysqlDatabase: 'd' };
    const store = new RouterConfigStore(cfg);
    (store as any).pool = pool;
    return store;
  }

  it('parses router_config rows and returns a RouterConfig', async () => {
    const pool = {
      query: async () => [[
        { config_key: 'commands', config_value: { help: 'help', ping: 'status' }, enabled: 1 },
        { config_key: 'prefixes', config_value: { kb: 'kb', doc: 'kb' }, enabled: 1 },
        { config_key: 'default_handler', config_value: { kind: 'kb' }, enabled: 1 },
        { config_key: 'command_only_mode', config_value: { enabled: true }, enabled: 1 },
      ]],
    };
    const store = makeStoreWithPool(pool);
    const cfg = await store.getConfig();
    expect(cfg.commands).toEqual({ help: 'help', ping: 'status' });
    expect(cfg.prefixes).toEqual({ kb: 'kb', doc: 'kb' });
    expect(cfg.defaultHandler).toBe('kb');
    expect(cfg.commandOnly).toBe(true);
  });

  it('falls back to defaults when MySQL throws', async () => {
    const pool = { query: async () => { throw new Error('mysql down'); } };
    const store = makeStoreWithPool(pool);
    const cfg = await store.getConfig();
    expect(cfg.commands.help).toBe('help');
    expect(cfg.commandOnly).toBe(false);
  });

  it('parses stringified JSON config_value columns', async () => {
    const pool = {
      query: async () => [[
        { config_key: 'commands', config_value: '{"help":"help","ping":"status"}', enabled: 1 },
        { config_key: 'default_handler', config_value: '{"kind":"tool"}', enabled: 1 },
      ]],
    };
    const store = makeStoreWithPool(pool);
    const cfg = await store.getConfig();
    expect(cfg.commands).toEqual({ help: 'help', ping: 'status' });
    expect(cfg.defaultHandler).toBe('tool');
  });

  it('caches results for 60s', async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        return [[{ config_key: 'commands', config_value: { help: 'help' }, enabled: 1 }]];
      },
    };
    const store = makeStoreWithPool(pool);
    await store.getConfig();
    await store.getConfig();
    await store.getConfig();
    expect(calls).toBe(1);
  });

  it('re-queries MySQL after invalidate()', async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        return [[{ config_key: 'commands', config_value: { help: 'help' }, enabled: 1 }]];
      },
    };
    const store = makeStoreWithPool(pool);
    await store.getConfig();
    store.invalidate();
    await store.getConfig();
    expect(calls).toBe(2);
  });
});