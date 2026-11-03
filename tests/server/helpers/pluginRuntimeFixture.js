import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import pluginsModule from '../../../server/src/modules/plugins/index.ts';
import ssePlugin from '../../../server/src/plugins/sse.ts';
import { AuthStore } from '../../../server/src/lib/authStore.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import { installPortFixture, requireFromServer, writeHttpPlugin } from './pluginInstallHttpFixture.js';

export const Fastify = requireFromServer('fastify');

/**
 * Один оборот event loop пропускает HTTP и promise cleanup без реальной задержки.
 * Fake timers тестов управляют только таймаутами проверяемого контракта.
 */
export async function settle() {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Код плагина сохраняет реальные options и scope в декораторе временного приложения.
 * Подготовка и уведомления настраиваются самим тестом, без импорта модулей ядра плагином.
 */
function serverSource(callback, marker) {
  return [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'imported');`,
    callback ? 'export default function plugin(app, options, done) {'
      : 'export default async function plugin(app, options) {',
    '  const probe = app.runtimeProbe.get(options.plugin.id);',
    '  probe.options = options;',
    '  probe.scope = app;',
    '  Object.assign(options.lifecycle, probe.hooks);',
    '  app.get("/x", async () => ({ ok: true }));',
    '  app.get("/human", async (request, reply) => {',
    '    if (request.authKind !== "session") {',
    '      return reply.code(403).send({ error: "human_only" });',
    '    }',
    '    return { ok: true };',
    '  });',
    '  app.get("/socket", { websocket: true }, (socket) => socket.send("ready"));',
    ...(callback ? ['  probe.done = true;', '  done();'] : []),
    '}',
  ].join('\n');
}

/**
 * Фикстура поднимает настоящий Fastify, auth и pluginsModule в собственном каталоге.
 * Ни pluginsDir, ни prefs, ни сессии не связаны с данными работающего владельца.
 */
export async function runtimeFixture(t, definitions = [{ id: 'demo' }], options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-runtime-'));
  const app = Fastify({ logger: false });
  const config = {
    userPluginsDir: path.join(root, 'plugins'),
    userPluginsDataDir: path.join(root, 'data'),
  };
  const probe = new Map();
  const { port } = installPortFixture();
  let data = {
    ...structuredClone(options.prefs ?? {}),
    plugins: {
      ...Object.fromEntries(definitions.map(({ id }) => [id, true])),
      ...options.prefs?.plugins,
    },
  };
  const writes = [];
  const prefs = {
    read: () => data,
    write(patch) {
      options.beforeWrite?.(patch);
      writes.push(structuredClone(patch));
      data = { ...data, ...structuredClone(patch) };
    },
  };

  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(config.userPluginsDir);
  app.decorate('runtimeProbe', probe);
  app.decorate('studio3d', { marker: 'studio' });
  app.decorate('projects', { marker: 'projects' });
  await app.register(requireFromServer('@fastify/websocket'));

  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'auth/account.json'),
    sessionsPath: path.join(root, 'auth/sessions.json'),
  });

  await app.register(authPlugin, {
    authStore,
    cliToken: 'runtime-cli',
    internalToken: 'runtime-internal',
  });

  if (options.sse) {
    await mkdir(path.join(root, 'events'));
    await app.register(ssePlugin, { stateDir: path.join(root, 'events') });
  } else {
    app.decorate('sse', { marker: 'sse' });
  }

  for (const definition of definitions) {
    const marker = path.join(root, `${definition.id}.import`);
    const record = { marker, hooks: definition.hooks ?? {} };
    const files = {
      'package.json': '{"type":"module"}',
      ...(definition.staticOnly ? {} : {
        [definition.entry ?? 'server.js']: serverSource(definition.callback, marker),
      }),
      ...(definition.web ? { 'web/index.html': '<p>Страница фикстуры</p>' } : {}),
      ...definition.files,
    };

    probe.set(definition.id, record);
    await writeHttpPlugin(config.userPluginsDir, definition.id, {
      name: definition.id,
      enabled: true,
      ...(definition.web ? { web: 'web' } : {}),
      ...definition.manifest,
    }, files);
  }

  await app.register(pluginsModule, {
    config,
    prefs,
    installs: port,
    documentReader: options.documentReader,
    runtimeServices: options.runtimeServices,
  });
  await app.ready();

  const session = { cookie: `grigdesk_sid=${authStore.createSession().id}` };
  const request = (method, url, payload, headers = session) => app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers,
  });

  return {
    root,
    app,
    config,
    prefs,
    writes,
    probe,
    port,
    session,
    request,
    toggle: (id, enabled) => request('POST', `/api/plugins/${id}/toggle`, { enabled }),
    settings: (id, payload) => request('PUT', `/api/plugins/${id}/settings`, payload),
    card: async (id) => (await request('GET', '/api/plugins')).json().plugins.find((p) => p.id === id),
    imported: async (id) => access(probe.get(id).marker).then(() => true, () => false),
  };
}

/**
 * Отсутствие core — исходный поведенческий RED, а не ошибка импорта будущего helper.
 * Остальные проверки вызывают методы только после явной проверки выдачи набора.
 */
export function pluginCore(fixture, id = 'demo') {
  const core = fixture.probe.get(id).options?.core;

  assert.ok(core, 'Загруженный плагин должен получить options.core');

  return core;
}
