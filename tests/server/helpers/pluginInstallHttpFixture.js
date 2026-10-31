import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { liveGroupMembers } from '../../../server/src/lib/packageInstall/workerIdentity.ts';

import { AuthStore } from '../../../server/src/lib/authStore.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import installRoutes from '../../../server/src/modules/plugins/installRoutes.ts';
import catalogRoutes from '../../../server/src/modules/plugin-catalog/index.ts';
import pluginsModule from '../../../server/src/modules/plugins/index.ts';
import { PluginInstallService } from '../../../server/src/lib/packageInstall/service.ts';
import { installJob, installedRecord } from './pluginInstallState.js';

export const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));

/**
 * Port fixture сохраняет аргументы каждого вызова для HTTP security assertions.
 * Все возвращаемые DTO полные и синтетические; секреты машины не используются.
 */
export function installPortFixture() {
  const calls = [];
  const job = installJob('ready');
  const record = installedRecord();
  const call = (name, args, result) => {
    calls.push({ name, args: structuredClone(args) });

    return structuredClone(result);
  };
  const port = {
    recover: async () => ({ blockedIds: [], error: null }),
    bindRuntime: (value) => port.runtime = value,
    close: async () => {},
    health: () => null,
    refreshCatalog: async () => {},
    restartRequired: () => false,
    describe: async () => null,
    currentJob: async () => call('currentJob', [], job),
    getJob: async (id) => call('getJob', [id], job),
    listVersions: async (url) => call('listVersions', [url],
      { source: record.source, versions: [job.target] }),
    startInstall: async (input) => call('startInstall', [input], job),
    startUpdate: async (id, input) => call('startUpdate', [id, input], job),
    apply: async (id, token) => call('apply', [id, token], { ...job, status: 'done' }),
    cancel: async (id) => call('cancel', [id], { ...job, status: 'cancelled' }),
    rollback: async (id, input) => call('rollback', [id, input], {
      ...job,
      status: 'done',
      kind: 'rollback',
    }),
    checkUpdates: async () => call('checkUpdates', [], {}),
  };

  return {
    port,
    calls,
    job,
    record,
  };
}

/**
 * Настоящий auth guard получает только временный account/session state.
 * Production Fastify defaults сохраняются; installer сам задаёт локальный validator.
 */
export async function installHttpFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-install-http-'));
  const pluginsDir = path.join(root, 'plugins');
  const userPluginsDataDir = path.join(root, 'data');
  const stub = installPortFixture();
  const installs = options.realService ? new PluginInstallService({
    pluginsDir,
    statePath: path.join(root, 'state/installs.json'),
    grigDeskVersion: '1.0.0',
    reservedIds: ['code'],
    ...options.serviceOptions,
  }) : options.installs ?? stub.port;
  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'auth/account.json'),
    sessionsPath: path.join(root, 'auth/sessions.json'),
  });
  const logs = [];
  const logger = options.captureLogs ? requireFromServer('pino')({ level: 'trace' }, {
    write: (text) => logs.push(text),
  }) : null;
  const app = requireFromServer('fastify')(logger ? { loggerInstance: logger } : { logger: false });
  const config = { userPluginsDir: pluginsDir, userPluginsDataDir };
  let data = structuredClone(options.prefs ?? {});
  const prefs = {
    read: () => data,
    write: (patch) => data = { ...data, ...structuredClone(patch) },
  };

  t.after(async () => {
    await app.close();

    if (options.blockedClose) {
      await assert.rejects(installs.close(), (error) =>
        ['recovery_required', 'state_invalid'].includes(error.code));
      assert.equal(installs.commands.size, 0);
      assert.equal(installs.mutations.size, 0);

      const disk = await installs.store.read().catch((error) => {
        if (error.code === 'state_invalid') {
          return null;
        }

        throw error;
      });

      for (const worker of Object.values(disk?.workers ?? {})) {
        assert.deepEqual(await liveGroupMembers(worker.pgid), []);
      }

      // Только fixture освобождает свой fd после окончания всех effect chains.
      // Production остаётся заблокированным до нового процесса recovery.
      await installs.owner.release();
    } else {
      await installs.close();
    }

    await rm(root, { recursive: true, force: true });
  });

  await mkdir(pluginsDir);

  if (options.setup) {
    await options.setup({
      root,
      pluginsDir,
      installs,
      config,
    });
  }

  options.configure?.(app);

  await app.register(authPlugin, {
    authStore,
    internalToken: 'fixture-internal',
    cliToken: 'fixture-cli',
  });

  if (options.registerRoutes) {
    await options.registerRoutes(app);
  }

  if (options.catalog) {
    await app.register(catalogRoutes, { catalog: options.catalog });
  }

  if (options.withPlugins) {
    await app.register(pluginsModule, {
      config,
      prefs,
      ...(options.withoutInstalls ? {} : { installs }),
    });
  } else {
    await app.register(installRoutes, { installs });
  }

  await app.ready();


  const session = { cookie: `grigdesk_sid=${authStore.createSession().id}` };
  const cli = { 'x-grigdesk-token': 'fixture-cli' };
  const internal = { 'x-grigdesk-internal': 'fixture-internal' };

  return {
    root,
    pluginsDir,
    userPluginsDataDir,
    app,
    installs,
    stub,
    session,
    cli,
    internal,
    prefs,
    logs,
  };
}

/**
 * Manifest и файлы пишутся в собственном plugin root до регистрации module.
 * Helper никогда не обращается к настоящему каталогу установленного GrigDesk.
 */
export async function writeHttpPlugin(pluginsDir, id, manifest = {}, files = {}) {
  const directory = path.join(pluginsDir, id);

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({
    id,
    version: '1.0.0',
    ...manifest,
  }));

  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }

  return directory;
}
