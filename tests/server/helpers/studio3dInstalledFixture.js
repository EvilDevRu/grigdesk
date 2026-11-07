import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import pluginsModule from '../../../server/src/modules/plugins/index.ts';
import { SESSION_ONLY_PREFIXES } from '../../../server/src/modules/plugins/installRoutes.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import authModule from '../../../server/src/modules/auth/index.ts';
import { AuthStore } from '../../../server/src/lib/authStore.ts';
import { PrefsStore } from '../../../server/src/lib/prefsStore.ts';
import { SYSTEM } from '../../../server/src/lib/pluginsRegistry.ts';
import { PluginInstallService } from '../../../server/src/lib/packageInstall/service.ts';
import { readPluginInstallConfiguration } from '../../../server/src/lib/packageInstall/configuration.ts';
import { createPluginRuntimeServices } from '../../../server/src/modules/plugins/runtimeServices.ts';
import projectsModule from '../../../server/src/modules/projects/index.ts';
import { createProjectsService } from '../../../server/src/modules/projects/service.ts';
import { DocumentReader } from '../../../server/src/lib/documents/reader.ts';
import { getProviderAdapters } from '../../../server/src/lib/executors/index.ts';
import { createTripoStudio } from '../../../server/src/lib/tripo/studio.ts';
import { nodeExecutable } from '../../../server/src/lib/runtimePaths.ts';
import { requireFromServer } from './pluginInstallHttpFixture.js';
import { startFakeTripo } from './fakeTripo.js';
import { makeGlb } from './studio3dGlb.js';
import { git } from './pluginRepo.js';

const artifactRoot = '/home/evildev/.grigdesk/artifacts/studio3d-extraction/installer-runs';
/**
 * Условие проверяет настоящие ответы с ограничением времени; reject не проглатывается.
 * Predicate timeout сообщает последний ответ, не превращается в skip.
 */
export async function installedUntil(read, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let value;

  do {
    value = await read();

    if (predicate(value)) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  assert.fail(`Fixture condition timeout: ${value?.body ?? JSON.stringify(value)}`);
}
/**
 * Настоящие installer/prefs/auth/core создаются вокруг готового export, без source build.
 * createEnvironment обязателен: ведущий передаст общий production seam шага15, fallback нет.
 */
export async function installedStudioFixture(t, options = {}) {
  const { createEnvironment } = options;
  const enabled = Object.hasOwn(options, 'enabled') ? options.enabled : true;

  assert.equal(typeof createEnvironment, 'function', 'Нужен production createPluginEnvironment(config)');
  await mkdir(artifactRoot, {
    recursive: true
  });

  const root = await mkdtemp(path.join(artifactRoot, 'installed-'));
  const boots = [];
  let fake;
  let adapters;
  let previous;
  let adapter;
  // Cleanup регистрируется сразу после создания root, до fake/provider/environment effects.
  t.after(async () => {
    const errors = [];

    for (const item of boots) {
      try {
        await item.close();
      }
      catch (error) {
        errors.push(error);
      }
    }

    if (adapters && adapter && adapters.get('tripo') === adapter) {
      adapters.set('tripo', previous);
    }
    if (fake) {
      try {
        await fake.close();
      }
      catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      // Не удаляем доказательства и пути процесса с неподтверждённым cleanup.
      throw new AggregateError(errors, 'Не завершён cleanup installed fixture');
    }

    await rm(root, {
      recursive: true, force: true
    });
  });

  const R = path.join(root, 'runtime');
  const config = {
    rootDir: R,
    studio3dDir: path.join(root, 'library-default'),
    dataStateDir: path.join(root, 'profile/data/state'),
    mobileDir: path.join(root, 'profile/data/mobile'),
    stateDir: path.join(root, 'profile/state'),
    chatsDir: path.join(root, 'profile/chats'),
    telegramDir: path.join(root, 'profile/telegram'),
    githubDir: path.join(root, 'profile/github'),
    profilesDir: path.join(root, 'profile/profiles'),
    routesDir: path.join(root, 'profile/routes'),
    userPluginsDir: path.join(root, 'extensions'),
    userPluginsDataDir: path.join(root, 'profile/plugin-data'),
    pluginInstallsStatePath: path.join(root, 'profile/install-state/installs.json'),
    factoryControlDir: path.join(root, 'profile/factory-control'),
    factoryConfigRoot: path.join(root, 'profile/factory-config'),
  };
  const libraryDir = path.join(root, 'custom-library');
  const prefsPath = path.join(root, 'profile/prefs.json');
  const projectDir = path.join(root, 'fixture-project');
  const libraryId = randomUUID();
  const seed = {
    ...(enabled === undefined ? {} : {
      plugins: {
        studio3d: enabled
      }
    }),
    pluginSettings: {
      studio3d: {
        libraryDir,
        autoImport: false,
        lowDiskGb: 37
      }
    },
    pluginPlacements: {
      studio3d: {
        'provider.popover.after-bars': false
      }
    },
    projects: {
      fixture: {
        title: 'Настоящий fixture project',
        description: '',
        tags: [],
        repos: [{
          key: 'main', dir: projectDir
        }],
        defaultRepoKey: 'main',
        archivedAt: null,
        revision: 0,
        createdAt: null,
        updatedAt: null,
        import: {
          status: 'none',
          source: null,
          error: null,
          checkedAt: null
        },
      }
    },
  };

  for (const directory of [R, path.dirname(prefsPath), config.userPluginsDir, projectDir, libraryDir]) {
    await mkdir(directory, {
      recursive: true
    });
  }

  await writeFile(path.join(R, 'VERSION'), '1.0.0\n');
  await writeFile(prefsPath, JSON.stringify(seed, null, 2) + '\n');
  await mkdir(path.join(root, 'profile/auth'), {
    recursive: true
  });
  await writeFile(path.join(root, 'profile/auth/account.json'), JSON.stringify({
    login: 'fixture-owner'
  }) + '\n');
  await writeFile(path.join(libraryDir, '.library.json'), JSON.stringify({
    schema: 1, libraryId
  }) + '\n');
  await git(projectDir, 'init', '-q');
  fake = await startFakeTripo();
  adapters = await getProviderAdapters();
  previous = adapters.get('tripo');
  adapter = {
    id: 'tripo',
    type: '3d',
    studio3d: createTripoStudio({
      env: fake.env,
      baseUrl: fake.baseUrl,
      sleep: async () => {
      },
    })
  };

  const events = [];
  const streams = new Set();
  const control = {
    beforeClose: null,
    expectedCloseError: null,
    /**
     * Создаёт только свой fixture stream и отслеживает его до close.
 * Уборка не затрагивает потоки приложения владельца.
     */
    openStream() {
      const stream = new PassThrough();

      streams.add(stream);
      stream.once('close', () => streams.delete(stream));

      return stream;
    },
  };
  const probe = {
    runtime: null,
    lifecycle: null,
    runtimePort: null,
    entryUrl: null
  };
  const prefs = new PrefsStore({
    prefsPath
  });
  const baselinePrefs = await readFile(prefsPath);
  const projects = createProjectsService({
    config, prefs
  });
  const environment = () => createEnvironment(config);
  const runtimeServices = createPluginRuntimeServices({
    config,
    project: (id) => projects.read(id),
    listProjects: () => projects.list(),
    environment,
    sandboxes: async () => [],
    holdSandbox: async () => () => {
    },
  });
  const reader = new DocumentReader({
    rootProviders: [() => [{
      id: 'fixture-project',
      label: 'Проект fixture',
      path: projectDir,
    }]]
  });

  adapters.set('tripo', adapter);
  assert.equal(environment().nodeExecutable, nodeExecutable());
  /**
   * Каждый boot использует новый настоящий app/service над теми же данными.
   * Частично созданные экземпляры регистрируются для cleanup до ready.
   */

  async function boot() {
    const service = new PluginInstallService({
      ...await readPluginInstallConfiguration(config),
      reservedIds: SYSTEM.map((manifest) => manifest.id),
    });
    const bind = service.bindRuntime.bind(service);
    // Наблюдатель сохраняет настоящий binding, не подменяет действия fake port-ом.
    service.bindRuntime = (port) => {
      probe.runtimePort = port;
      bind(port);
    };

    const booted = {
      app: null,
      service,
      closed: false,
      /**
       * Закрывает app и service даже при частичном boot или ошибке onClose.
   * Неизвестная ошибка остаётся отказом cleanup и сохраняет evidence tree.
       */
      async close() {
        if (this.closed) {
          return;
        }

        this.closed = true;

        for (const stream of streams) {
          stream.destroy();
        }

        try {
          try {
            await this.app?.close();
          }
          catch (error) {
            if (!control.expectedCloseError) {
              throw error;
            }

            assert.match(String(error), control.expectedCloseError);
          }
        }
        finally {
          await service.close();
        }
      },
    };
    // Даже ошибка конструктора auth или register/ready оставляет app/service под cleanup.
    boots.push(booted);

    const app = requireFromServer('fastify')({
      logger: false
    });

    booted.app = app;

    const authStore = new AuthStore({
      legacyAccountPath: path.join(root, 'profile/auth/account.json'),
      sessionsPath: path.join(root, 'profile/auth/sessions.json'),
    });

    app.decorate('sse', {
      /**
       * Синхронный bridge связывает только derived fixture с её control.
       * Реальные события сохраняются отдельно и продолжают путь через общий core.
       */
      broadcast(event, data) {
        if (event === 'plugin-event' && data.event === 'fixture-installed-control') {
          data.data.bridge.control = control;
        }

        if (event === 'plugin-event' && data.event === 'fixture-installed-runtime') {
          Object.assign(probe, data.data);
        }

        events.push({
          event, data
        });
      }
    });
    await app.register(authPlugin, {
      authStore,
      cliToken: 'fixture-cli',
      internalToken: 'fixture-internal',
      sessionOnlyPrefixes: SESSION_ONLY_PREFIXES,
    });
    await app.register(authModule, {
      authStore
    });
    await app.register(projectsModule, {
      config,
      prefs,
      service: projects,
    });
    await app.register(pluginsModule, {
      config,
      prefs,
      installs: service,
      runtimeServices,
      documentReader: reader,
      grigDeskVersion: '1.0.0',
    });
    await app.ready();

    const session = {
      cookie: `grigdesk_sid=${authStore.createSession().id}`
    };
    const request = (method, url, payload, auth = 'session', extra = {}) => app.inject({
      method,
      url,
      ...(payload === undefined ? {} : {
        payload
      }),
      headers: {
        ...(auth === 'session' ? session : auth === 'cli'
          ? {
            'x-grigdesk-token': 'fixture-cli'
          } : auth === 'internal'
            ? {
              'x-grigdesk-internal': 'fixture-internal'
            } : {}), ...extra
      },
    });

    Object.assign(booted, {
      app,
      server: app,
      service,
      installs: service,
      request,
      session,
      authStore,
      address: null,
      call: (method, suffix, payload, auth, extra) =>
        request(method, `/api/ext/studio3d${suffix}`, payload, auth, extra),
      plugin: (method, suffix, payload, auth, extra) =>
        request(method, `/api/plugins/studio3d${suffix}`, payload, auth, extra),
      settings: (values) => request('PUT', '/api/plugins/studio3d/settings', {
        values
      }),
      async listen() {
        if (!this.address) {
          this.address = await app.listen({
            host: '127.0.0.1', port: 0
          });
        }

        return this.address;
      },
      card: async () => (await request('GET', '/api/plugins')).json().plugins
        .find((plugin) => plugin.id === 'studio3d'),
      toggle: (value) => request('POST', '/api/plugins/studio3d/toggle', {
        enabled: value
      }),
    });

    return booted;
  }

  return {
    root,
    config,
    prefs,
    prefsPath,
    baselinePrefs,
    libraryId,
    libraryDir,
    projectDir,
    environment,
    probe,
    control,
    streams,
    events,
    fake,
    boot,
    creates: () => fake.requests.filter((item) => item.path === '/v3/generation/text-to-model'),
  };
}
/**
 * Применение выполняет настоящий stage/preview/token путь; ошибка не скрывается behind status.
 * Git repo и service — исключительно временные объекты этой fixture.
 */
export async function installStudio(boot, repo, version = '1.0.0') {
  await boot.service.startInstall({
    url: repo.url,
    version,
    expectedId: 'studio3d'
  });
  await boot.service.whenIdle();

  const ready = await boot.service.currentJob();

  assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
  assert.equal((await boot.service.apply(ready.id, ready.reviewToken)).status, 'done');

  return ready;
}
/**
 * Готовит derived fixture версию настоящим installer без apply.
 * Возвращает конкретный ready token для отдельного тестового подтверждения.
 */

export async function stageStudioUpdate(boot) {
  await boot.service.startUpdate('studio3d', {
    version: '1.0.1'
  });
  await boot.service.whenIdle();

  const ready = await boot.service.currentJob();

  assert.equal(ready.status, 'ready', JSON.stringify(ready.error));

  return ready;
}
/**
 * Передаёт настоящий multipart GLB с обязательным первым libraryId.
 * Транспорт использует только изолированный установленный router.
 */

export async function uploadInstalledGlb(boot, libraryId, bytes = makeGlb()) {
  const boundary = 'fixture-installed-studio';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="libraryId"\r\n\r\n`
      + `${libraryId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; `
      + 'filename="fixture.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return boot.call('POST', '/uploads', body, 'session', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  });
}
