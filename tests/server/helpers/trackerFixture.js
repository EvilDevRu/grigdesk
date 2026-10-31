import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { B24Adapter } from '../../../server/src/adapters/b24.ts';
import { CredsStore } from '../../../server/src/lib/b24/credsStore.ts';
import b24Module from '../../../server/src/modules/b24/index.ts';
import ownModule from '../../../server/src/modules/grigdesk-tasks/index.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import { AuthStore } from '../../../server/src/lib/authStore.ts';
import { tasksFixture } from './grigdesk-tasks.js';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const runtimeUrl = new URL('../../../server/src/lib/trackers/runtime.ts', import.meta.url);
const moduleUrl = new URL('../../../server/src/modules/trackers/index.ts', import.meta.url);

export const CUSTOM_CAPABILITIES = Object.fromEntries([
  'create', 'timer', 'comments', 'attachments', 'widgets', 'editing',
  'complete', 'renew', 'users', 'projects',
].map((key) => [key, true]));
export const STOCK_CAPABILITIES = Object.fromEntries(Object.keys(CUSTOM_CAPABILITIES)
  .map((key) => [key, ['create', 'complete', 'users', 'projects'].includes(key)]));

/**
 * Пакет фикстуры — исполняемый драйвер с одинаковым локальным номером задачи.
 * Счётчики лежат только в его временном каталоге и показывают реальный выбор registry.
 */
export async function writeTracker(config, id, { manifest = {}, code = null } = {}) {
  const directory = path.join(config.driversDir, id);
  const callsPath = path.join(directory, 'calls.jsonl');
  const driver = `
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(directory, 'imported'))}, 'yes');
const record = (method, args) => appendFileSync(${JSON.stringify(callsPath)},
  JSON.stringify({ method, args }) + '\\n');
export default function createDriver() {
  const task = { id: 42, source: 'b24', title: ${JSON.stringify(id)}, status: 3 };
  const identity = { baseUrl: 'https://tracker.fixture', userId: 7 };
  return {
    id: ${JSON.stringify(id)},
    capabilities: ${JSON.stringify(CUSTOM_CAPABILITIES)},
    isConfigured: () => true,
    accountIdentity: async () => { record('accountIdentity', []); return identity; },
    testAuth: async () => ({ ok: true, userId: 7 }),
    listTasks: async () => [task],
    taskDetail: async (id) => { record('taskDetail', [id]); return task; },
    taskPageData: async (id) => { record('taskPageData', [id]); return { comments: [] }; },
    getDashboard: async () => ({ tasks: [task], toReview: [], created: [], widgets: [] }),
    createTask: async (input) => { record('createTask', [input]); return { ok: true, id: 43 }; },
    updateTask: async () => ({ ok: true }),
    addComment: async () => ({ ok: true }),
    timer: async () => ({ ok: true }),
    completeTask: async () => ({ ok: true }),
    renewTask: async () => ({ ok: true }),
    findUsers: async () => [{ id: 7, name: 'Исполнитель' }],
    listGroups: async () => [{ id: 9, name: 'Проект' }],
    sourceUrl: (id) => 'https://tracker.fixture/t/' + id,
    probeTaskNumber: async () => 'absent',
    dispose: async () => {},
  };
}
`;

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'driver.json'), JSON.stringify({
    id,
    name: `Драйвер ${id}`,
    version: '1.0.0',
    contract: 1,
    settings: {},
    ...manifest,
  }));
  await writeFile(path.join(directory, 'driver.ts'), code ?? driver);

  return directory;
}

/**
 * Fixture использует ту же runtime factory, что приложение, когда она появится.
 * На исходнике регистрируются старый B24 HTTP и штатный 404 новых API, без будущих imports.
 */
export async function trackerFixture(t, { legacy = false, setup = null, fetch: transport } = {}) {
  const ownCleanups = [];
  const own = await tasksFixture({ after: (cleanup) => ownCleanups.push(cleanup) });
  const { config, root } = own;

  Object.assign(config, {
    driversDir: path.join(root, 'drivers'),
    driverInstallsPath: path.join(root, 'state/driver-installs.json'),
    trackerSettingsPath: path.join(root, 'state/tracker-settings.json'),
    trackerCredentialsPath: path.join(root, 'state/tracker-credentials.json'),
    b24CredsPath: path.join(root, 'state/b24.json'),
    b24CookiePath: path.join(root, 'state/cookies.json'),
  });
  await mkdir(config.driversDir, { recursive: true });

  const credsStore = new CredsStore({ credsPath: config.b24CredsPath, baseUrl: 'https://tracker.fixture' });

  if (legacy) {
    credsStore.write({ login: 'fixture-user', password: 'fixture-password' });
  }

  await setup?.(config);

  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'auth/account.json'),
    sessionsPath: path.join(root, 'auth/sessions.json'),
  });
  const logs = [];
  const logger = requireFromServer('pino')({ level: 'trace' }, {
    write: (value) => logs.push(value),
  });
  const app = requireFromServer('fastify')({ loggerInstance: logger });
  const events = [];

  app.decorate('sse', { broadcast: (name, payload) => events.push({ name, payload }) });
  await app.register(authPlugin, {
    authStore,
    cliToken: 'tracker-test-cli',
    internalToken: 'tracker-test-internal',
  });

  const options = {
    ...own.moduleOptions,
    config,
    credsStore,
    fetch: transport
  };
  const runtime = existsSync(runtimeUrl)
    ? await (await import(runtimeUrl.href)).createTrackerRuntime(options)
    : null;
  const b24 = runtime?.b24 ?? new B24Adapter({ credsStore, cookiePath: config.b24CookiePath });

  if (existsSync(moduleUrl)) {
    await app.register((await import(moduleUrl.href)).default, { ...options, runtime });
  }

  app.decorate('pluginEnabled', () => false);
  app.decorate('analyzer', { enqueue: async () => {} });
  await app.register(b24Module, { b24 });
  await app.register(ownModule, {
    ...options,
    b24,
    service: runtime?.own
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await runtime?.close();

    for (const cleanup of ownCleanups) {
      await cleanup();
    }
  });

  const headers = { cookie: `grigdesk_sid=${authStore.createSession().id}` };
  const request = (method, url, payload, extra = {}) => app.inject({
    method,
    url,
    payload,
    headers: { ...headers, ...extra },
  });

  return {
    ...own,
    app,
    config,
    credsStore,
    logs,
    runtime,
    b24,
    headers,
    events,
    request
  };
}
/**
 * Сначала проверяется настоящий catalog response: отсутствие функции даёт HTTP RED.
 * Поколение берётся из того же settings API, которое допускает последующую запись.
 */
export async function selectTracker(fixture, externalId, settings = {}) {
  const current = await fixture.request('GET', '/api/trackers/settings');

  assert.equal(current.statusCode, 200, 'TRACKER: settings API должен существовать');

  const response = await fixture.request('POST', '/api/trackers/settings', {
    externalId,
    settings,
    expectedRevision: current.json().revision,
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.json();
}
/**
 * Журнал вызываемого пакета отделён от runtime и позволяет различить A и B.
 * Отсутствующий файл означает ноль вызовов, а не чтение живых данных пользователя.
 */
export async function trackerCalls(config, id) {
  const file = path.join(config.driversDir, id, 'calls.jsonl');

  if (!existsSync(file)) {
    return [];
  }

  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}
