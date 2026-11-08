// Интеграция source плагина с настоящим loader/core/auth ядра, без установки выпуска.
// Все записи принадлежат изолированной fixture; provider использует только fake loopback API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { build } from '../../../web/node_modules/esbuild/lib/main.js';
import Fastify from '../../../server/node_modules/fastify/fastify.js';
import pluginsModule from '../../../server/src/modules/plugins/index.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import authModule from '../../../server/src/modules/auth/index.ts';
import { createPluginRuntimeServices } from '../../../server/src/modules/plugins/runtimeServices.ts';
import { getProviderAdapters } from '../../../server/src/lib/executors/index.ts';
import { createTripoStudio } from '../../../server/src/lib/tripo/studio.ts';
import { DocumentReader } from '../../../server/src/lib/documents/reader.ts';
import { createPluginEnvironment } from '../../../server/src/lib/pluginEnvironment.ts';
import { scanUserPlugins } from '../../../server/src/lib/pluginsRegistry.ts';
import { png } from '../../helpers/pluginV1.js';
import { startFakeTripo } from './fakeTripo.js';
import { makeGlb } from './studio3dGlb.js';

const artifactRoot = path.join(process.env.GRIGDESK_ARTIFACTS_DIR
  ?? path.join(os.homedir(), '.grigdesk/artifacts'), 'studio3d-extraction');
const developmentDir = process.env.STUDIO3D_DEVELOPMENT_DIR;
const providerStack = [];
let providerBaseline;

if (developmentDir && !path.isAbsolute(developmentDir)) {
  throw new Error('STUDIO3D_DEVELOPMENT_DIR должен быть абсолютным путём.');
}

if (developmentDir) {
  await fs.access(path.join(developmentDir, 'src/server/index.ts'));
}

export const hasStudioDevelopment = Boolean(developmentDir);

/**
 * Отсутствующий opt-in виден обычному core CI; явно переданный неверный путь падает.
 * Локальные ворота обязаны задавать env и получать ноль пропущенных проверок.
 */
export function studioIntegrationTest(test, name, callback, options = {}) {
  return test(name, {
    ...options,
    skip: !developmentDir && 'Нужен STUDIO3D_DEVELOPMENT_DIR: реальная source integration.',
  }, callback);
}

/**
 * Ожидание проверяет наблюдаемое условие с ограниченным deadline, без паузы сервера.
 * Последний ответ возвращается вызывающему, чтобы assertions видели фактический DTO.
 */
export async function studioUntil(read, accept, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let value;

  do {
    value = await read();

    if (accept(value)) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  const diagnostic = value?.statusCode
    ? { statusCode: value.statusCode, body: value.body } : value;

  assert.fail(`Не выполнено условие fixture: ${JSON.stringify(diagnostic)}`);
}

/**
 * Bundle использует настоящий product entry и сохраняет относительный runtime worker.
 * Wrapper только наблюдает локальный runtime через действующий core.emit; production hook не добавляется.
 */
async function buildPackage(pluginDir, { web = false } = {}) {
  await fs.mkdir(path.join(pluginDir, 'runtime'), { recursive: true });

  const sourceEntry = path.join(developmentDir, 'src/server/index.ts');
  const wrapper = [
    `import product from ${JSON.stringify(sourceEntry)};`,
    'export default async function fixtureEntry(app, options) {',
    '  await product(app, options);',
    '  options.core.emit("fixture-runtime", {runtime: app.studio3d, lifecycle: options.lifecycle});',
    '}',
  ].join('\n');
  const result = await build({
    stdin: {
      contents: wrapper,
      sourcefile: 'studio3d-fixture-entry.mjs',
      resolveDir: developmentDir
    },
    outfile: path.join(pluginDir, 'server.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['node:*'],
    banner: { js: 'import { createRequire } from "node:module"; '
      + 'const require = createRequire(import.meta.url);' },
    metafile: true,
    legalComments: 'eof',
  });

  await fs.copyFile(path.resolve(developmentDir, '../runtime/analysisWorker.mjs'),
    path.join(pluginDir, 'runtime/analysisWorker.mjs'));
  await fs.mkdir(path.join(pluginDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'assets/icon.png'), png);
  await fs.writeFile(path.join(pluginDir, 'package.json'), '{"type":"module"}\n');

  if (web) {
    const directory = path.join(pluginDir, 'ui');

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'panel.js'), 'export default {render: () => null};\n');
    await fs.writeFile(path.join(directory, 'background.js'), 'export const start = () => {};\n');
    await fs.writeFile(path.join(directory, 'panel.css'), '/* Изолированная source fixture. */\n');
    await fs.writeFile(path.join(directory, 'ru.json'), '{}\n');
    await fs.writeFile(path.join(directory, 'en.json'), '{}\n');
  }

  await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    id: 'studio3d',
    name: '3D fixture',
    description: 'Изолированная проверка loader Studio3D',
    icon: 'assets/icon.png',
    version: '0.1.0',
    api: 1,
    defaultEnabled: false,
    entrypoints: {
      server: 'server.mjs',
      ...(web ? { web: {
        dir: 'ui',
        entry: 'panel.js',
        background: 'background.js',
        css: ['panel.css'],
        locales: { ru: 'ru.json', en: 'en.json' },
      } } : {}),
    },
    contributes: {
      ...(web ? { panels: [{
        title: '3D',
        group: 'dock',
        order: 30,
        hotkey: 'Ctrl+Shift+Digit7',
      }] } : {}),
      settings: [
      {
        key: 'autoImport',
        label: 'Импорт',
        type: 'checkbox',
        default: true
      },
      {
        key: 'lowDiskGb',
        label: 'Свободное место',
        type: 'number',
        default: 10,
        min: 1,
        max: 1000
      },
      {
        key: 'libraryDir',
        label: 'Библиотека',
        type: 'text',
        default: ''
      },
    ] },
  }, null, 2));

  const serverBytes = await fs.readFile(path.join(pluginDir, 'server.mjs'));

  return { metafile: result.metafile, serverSha256: createHash('sha256').update(serverBytes).digest('hex') };
}

/**
 * Реальный plugin registry создаёт UserPluginRuntime, core capabilities и lifecycle gate.
 * Только prefs, проекты и fake provider принадлежат fixture; системный studio3d из SYSTEM не вычитается.
 */
export async function studioPluginFixture(t, { enabled = true, settings = {}, seed, ...overrides } = {}) {
  await fs.mkdir(path.join(artifactRoot, 'lifecycle-runs'), { recursive: true });

  const root = overrides.existingRoot
    ?? await fs.mkdtemp(path.join(artifactRoot, 'lifecycle-runs', 'case-'));

  assert.equal(path.dirname(root), path.join(artifactRoot, 'lifecycle-runs'));

  const pluginsDir = path.join(root, 'extensions');
  const pluginDir = path.join(pluginsDir, 'studio3d');
  const profile = path.join(root, 'profile');
  const repo = path.join(root, 'repo');
  const config = {
    rootDir: profile,
    studio3dDir: path.join(profile, '3d'),
    dataStateDir: path.join(profile, 'data/state'),
    mobileDir: path.join(profile, 'data/mobile'),
    stateDir: path.join(profile, '.state'),
    chatsDir: path.join(profile, 'chats'),
    telegramDir: path.join(profile, 'telegram'),
    githubDir: path.join(profile, 'github'),
    profilesDir: path.join(profile, 'profiles'),
    factoryControlDir: path.join(profile, 'factory-control'),
    factoryConfigRoot: path.join(profile, 'factory-config'),
    userPluginsDir: pluginsDir,
    userPluginsDataDir: path.join(profile, 'plugin-data'),
  };

  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(repo, { recursive: true });

  await fs.mkdir(pluginsDir, { recursive: true });

  const built = overrides.noPackage ? null : await buildPackage(pluginDir, { web: overrides.web });
  const scanned = await scanUserPlugins(pluginsDir);

  if (overrides.noPackage) {
    assert.equal(scanned.some((item) => item.id === 'studio3d'), false);
  } else {
    assert.notEqual(scanned[0]?.compatibility?.status, 'incompatible',
      JSON.stringify(scanned[0]?.compatibility));
  }

  const fake = await startFakeTripo();
  const adapters = await getProviderAdapters();
  const previous = adapters.get('tripo');
  const provider = createTripoStudio({
    env: fake.env,
    baseUrl: fake.baseUrl,
    sleep: async () => {}
  });
  const server = Fastify({ logger: false });
  const probe = {
    runtime: null,
    lifecycle: null,
    events: [],
    runtimePort: null
  };
  const initialSettings = typeof settings === 'function'
    ? settings({
      root: profile,
      fixtureRoot: root,
      config,
      pluginDir
    }) : settings;
  const prefsStore = {
    fail: false,
    value: { plugins: { studio3d: enabled }, pluginSettings: { studio3d: {

      autoImport: false,
      lowDiskGb: 10,
      libraryDir: '',
      ...initialSettings,

    } } },
    read() {
      return this.value;
    },
    write(patch) {
      if (this.fail) {
        throw new Error('fixture-prefs-write');
      }

      this.value = { ...this.value, ...patch };
    },
  };
  const reader = new DocumentReader({ rootProviders: [() => [{
    id: 'repo',
    label: 'Проект',
    path: repo
  }]] });
  const project = {
    id: 'fixture-project',
    repos: [{ key: 'main', dir: repo }],
    archivedAt: null
  };
  const environment = () => createPluginEnvironment(config);
  const runtimeServices = createPluginRuntimeServices({
    config,
    project: async (id) => id === project.id ? project : null,
    listProjects: async () => [project],
    environment,
    sandboxes: async () => [],
    holdSandbox: async () => () => {},
    ...overrides.runtimePorts,
  });

  const adapter = {
    id: 'tripo',
    type: '3d',
    studio3d: provider,
  };

  if (!providerStack.length) {
    providerBaseline = previous;
  }

  providerStack.push(adapter);
  adapters.set('tripo', adapter);
  server.decorate('sse', { broadcast(event, data) {
    if (event === 'plugin-event' && data.event === 'fixture-runtime') {
      probe.runtime = data.data.runtime;
      probe.lifecycle = data.data.lifecycle;

      return;
    }

    probe.events.push({ event, data });
  } });

  t.after(async () => {
    await server.close();

    providerStack.splice(providerStack.indexOf(adapter), 1);

    if (adapters.get('tripo') === adapter) {
      adapters.set('tripo', providerStack.at(-1) ?? providerBaseline);
    }

    if (!providerStack.length) {
      providerBaseline = undefined;
    }

    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  await seed?.({
    root,
    repo,
    pluginDir,
    config,
    environment,
    runtimeServices,
    reader,
    provider,
    fake
  });

  const authStore = {
    clientScope: overrides.authScope ?? 'owner A',
    isConfigured: () => true,
    isValidSession: (id) => id === 'fixture-session',
  };

  await server.register(authPlugin, {
    authStore,
    cliToken: 'fixture-cli-token',
    internalToken: 'fixture-internal-token'
  });
  await server.register(authModule, { authStore });

  const installs = {
    recover: async () => ({ blockedIds: [] }),
    bindRuntime(port) {
      probe.runtimePort = port;
    },
    describe: async () => null,
    health: () => null,
  };
  const previousTmp = process.env.TMPDIR;

  process.env.TMPDIR = root;

  try {
    await server.register(pluginsModule, {
      config,
      prefs: prefsStore,
      runtimeServices,
      documentReader: reader,
      installs,
    });
    await server.ready();
  } finally {
    if (previousTmp === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmp;
    }
  }

  Object.defineProperty(server, 'studio3d', { get: () => probe.runtime });

  const headers = (auth) => auth === 'session' ? { cookie: 'grigdesk_sid=fixture-session' }
    : auth === 'cli' ? { 'x-grigdesk-token': 'fixture-cli-token' }
      : auth === 'internal' ? { 'x-grigdesk-internal': 'fixture-internal-token' } : {};
  const call = (method, url, payload, auth = 'session', extraHeaders = {}) => server.inject({

    method,
    url: `/api/ext/studio3d${url}`,
    payload,
    headers: { ...headers(auth), ...extraHeaders },

  });
  const plugin = (method, url, payload) => server.inject({

    method,
    url: `/api/plugins/studio3d${url}`,
    payload,
    headers: headers('session'),

  });

  if (enabled && !overrides.allowUnavailable && !overrides.noPackage) {
    await studioUntil(() => call('GET', '/state'), (response) => response.statusCode === 200
      && response.json().library.ok);
  }

  return {

    root: profile,
    fixtureRoot: root,
    repo,
    config,
    pluginsDir,
    pluginDir,
    server,

    fake,
    probe,
    provider,
    prefsStore,
    authStore,

    call,
    plugin,
    environment,
    built,
    request: (method, url, payload, auth = 'session', extraHeaders = {}) => server.inject({
      method,
      url,
      payload,
      headers: { ...headers(auth), ...extraHeaders },
    }),

    libraryId: enabled && !overrides.noPackage ? (await call('GET', '/state')).json().libraryId : null,

    runtime: () => probe.runtime,
    rebuildPackage: () => buildPackage(pluginDir, { web: overrides.web }),

    async setEnabled(value) {
      return plugin('POST', '/toggle', { enabled: value });
    },

  };
}

/**
 * API получает реальный multipart GLB и library marker той же сессии.
 * Поддельный MIME/bytes можно передать отдельно для отрицательных проверок.
 */
export function uploadStudioModel(f, bytes = makeGlb(), name = 'model.glb') {
  const boundary = 'studio-loader-fixture';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="libraryId"\r\n\r\n`
      + `${f.libraryId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; `
      + `filename="${name}"\r\nContent-Type: model/gltf-binary\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return f.call('POST', '/uploads', body, 'session',
    { 'content-type': `multipart/form-data; boundary=${boundary}` });
}

/**
 * Source imports служат только подготовке прежних durable fixtures до boot loader.
 * Переданный env путь проверен выше; ошибки файла не превращаются в skip.
 */
export function studioProduct(relative) {
  return import(pathToFileURL(path.join(developmentDir, 'src', relative)).href);
}
