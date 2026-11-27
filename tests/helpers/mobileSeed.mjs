// Ворота и курсор журнала: проекция не рисует ложное «ждёт тебя»,
// а /gate отказывает решению для ворот, на которых маршрут не стоит.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { computeNodeStatuses } from '../../server/src/lib/factoryGraph.ts';
import { readFactoryAttemptLedger } from '../../server/src/lib/factoryAttemptLedger.ts';
import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';

import authPlugin from '../../server/src/plugins/auth.ts';
import trackerModule from '../../server/src/modules/tracker/index.ts';
import mobileModule from '../../server/src/modules/mobile/index.ts';
import { MobileService } from '../../server/src/lib/mobile/service.ts';
import { chatAppFixture, controlledExecutor } from '../server/helpers/chat-turns.js';

import factoryModule from '../../server/src/modules/factory/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);
const CATALOG_HASH = 'b'.repeat(64);
const HEAD_HASH = 'c'.repeat(64);

// Каноническая форма digest_value движка (engine/lib/attempt-stage-state.sh):
// json.dumps(sort_keys, separators=(",",":"), ensure_ascii=False) + "\n".
// Синтетическое состояние воспроизводит trusted контракт движка во временном каталоге.
// Помощник не обращается к пользовательским прогонам или внешним аккаунтам.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

// Синтетическое состояние воспроизводит trusted контракт движка во временном каталоге.
// Помощник не обращается к пользовательским прогонам или внешним аккаунтам.
function stageRuntime({
  node = 'gate_accept',
  state = 'paused',
  sequence = 8,
  stop = state === 'stopped' ? 'done' : null,
} = {}) {
  return {
    schema: 1,
    protocolVersion: 2,
    taskId: '7',
    attemptId: ATTEMPT,
    profile: 'demo',
    catalogHash: CATALOG_HASH,
    route: 'feature',
    routeHash: ROUTE_HASH,
    entry: 'build',
    sequence,
    headEventHash: HEAD_HASH,
    cursor: {
      currentNode: state === 'stopped' ? null : node,
      lastCommit: {
        node: 'lint',
        outcome: 'done',
        sequence: sequence - 1,
      },
      pauseReason: state === 'paused' ? 'human-gate' : null,
      state,
      stop,
    },
  };
}

// Синтетическое состояние воспроизводит trusted контракт движка во временном каталоге.
// Помощник не обращается к пользовательским прогонам или внешним аккаунтам.
function runtimeEnvelope(runtime) {
  const checksum = createHash('sha256')
    .update(`${canonicalJson(runtime)}\n`, 'utf8')
    .digest('hex');

  return `${JSON.stringify(
    {
      checksum,
      runtime,
    },
    null,
    2,
  )}\n`;
}

// Синтетическое состояние воспроизводит trusted контракт движка во временном каталоге.
// Помощник не обращается к пользовательским прогонам или внешним аккаунтам.
function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Синтетическое состояние воспроизводит trusted контракт движка во временном каталоге.
// Помощник не обращается к пользовательским прогонам или внешним аккаунтам.
async function writeCheckedJson(dir, name, value) {
  const content = jsonBytes(value);

  await writeFile(path.join(dir, `${name}.json`), content, { mode: 0o400 });
  await writeFile(
    path.join(dir, `${name}.sha256`),
    `${createHash('sha256').update(content).digest('hex')}\n`,
    { mode: 0o400 },
  );
}

// Синтетическое состояние воспроизводит trusted контракт движка во временном каталоге.
// Помощник не обращается к пользовательским прогонам или внешним аккаунтам.
async function writeContentAddressedJson(dir, prefix, value) {
  const content = jsonBytes(value);
  const hash = createHash('sha256').update(content).digest('hex');

  await writeFile(path.join(dir, `${prefix}.${hash}.json`), content, { mode: 0o400 });
}

// Полный trusted ledger попытки; runtime.json пишется, только если cursor задан.
// Синтетическое состояние воспроизводит trusted контракт движка во временном каталоге.
// Помощник не обращается к пользовательским прогонам или внешним аккаунтам.
export async function seedFactory(t, { cursor = null, rootDirectory = null } = {}) {
  const root = rootDirectory || (await mkdtemp(path.join(os.tmpdir(), 'grigdesk-gate-cursor-')));
  const stateDir = path.join(root, 'state');
  const controlDir = path.join(root, 'control');
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const binDir = path.join(root, 'bin');
  const worktree = path.join(root, 'worktree');
  const callsLog = path.join(root, 'factory.calls');
  const factoryBin = path.join(binDir, 'factory');

  if (rootDirectory) {
    await access(path.join(root, '.test-mobile-seed'));
  } else {
    await writeFile(path.join(root, '.test-mobile-seed'), 'Синтетический стенд\n', { mode: 0o600 });
    await Promise.all([
      mkdir(controlDir, { mode: 0o700 }),
      mkdir(path.join(stateDir, 'logs'), { recursive: true }),
      mkdir(routesDir, { recursive: true }),
      mkdir(path.join(profilesDir, 'demo'), { recursive: true }),
      mkdir(binDir, { recursive: true }),
      mkdir(worktree, { recursive: true }),
    ]);

    const taskRoot = path.join(controlDir, 'protocol-v2', 'tasks', 't7');
    const attemptDir = path.join(taskRoot, 'attempts', ATTEMPT);

    await mkdir(path.join(attemptDir, 'artifacts'), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      path.join(taskRoot, 'protocol.json'),
      jsonBytes({
        protocolVersion: 2,
        schema: 1,
      }),
      { mode: 0o400 },
    );
    await writeCheckedJson(attemptDir, 'attempt', {
      schema: 1,
      protocolVersion: 2,
      attemptId: ATTEMPT,
      taskId: '7',
      profile: 'demo',
      createdAt: '2026-08-02T12:00:00Z',
      routesDir,
      catalogHash: CATALOG_HASH,
      origin: 'fresh',
      previousAttemptId: null,
      recoveryReason: null,
    });
    await writeCheckedJson(attemptDir, 'pins', {
      schema: 1,
      protocolVersion: 2,
      attemptId: ATTEMPT,
      taskId: '7',
      profile: 'demo',
      catalogHash: CATALOG_HASH,
      bootstrap: {
        id: 'scout',
        catalogHash: CATALOG_HASH,
      },
    });
    await writeContentAddressedJson(attemptDir, 'route-pin', {
      schema: 1,
      protocolVersion: 2,
      attemptId: ATTEMPT,
      taskId: '7',
      profile: 'demo',
      catalogHash: CATALOG_HASH,
      routeId: 'feature',
      routeHash: ROUTE_HASH,
      selectedAt: '2026-08-02T12:01:00Z',
    });
    await writeFile(
      path.join(attemptDir, 'artifacts', 'profile-contract.tsv'),
      [
        'schema\t1',
        'repos-mode\tgeneric',
        'workspace-mode\tisolated',
        'stand-ownership\ttask',
        'source-branch\tfactory/t7',
        'container\tdemo',
        'service-host\t127.0.0.1',
        `repo\tdemo\t${worktree}\t${worktree}\tfactory/t7`,
        '',
      ].join('\n'),
      { mode: 0o400 },
    );
    await writeFile(
      path.join(taskRoot, 'active-attempt.json'),
      jsonBytes({
        schema: 1,
        protocolVersion: 2,
        taskId: '7',
        attemptId: ATTEMPT,
      }),
      { mode: 0o400 },
    );

    if (cursor) {
      const stageDir = path.join(attemptDir, 'stage-results');

      await mkdir(stageDir, { mode: 0o700 });
      await writeFile(
        path.join(stageDir, 'runtime.json'),
        typeof cursor === 'string' ? cursor : runtimeEnvelope(stageRuntime(cursor)),
        { mode: 0o400 },
      );
    }

    await writeFile(
      path.join(stateDir, 't7.pipeline'),
      [
        'PROFILE=demo',
        'ROUTE=feature',
        'RUN_PROTOCOL=2',
        'CATALOG_PROTOCOL=route-v2',
        `ATTEMPT_ID=${ATTEMPT}`,
        `ROUTE_HASH=${ROUTE_HASH}`,
        'DELIVERY_MODE=disabled',
        'WF_STATUS=running',
        'STALLED_HUMAN=1',
        'BUILD=done',
        'LINT=done',
        'GATE_ACCEPT=waiting',
        'SHIP=pending',
        '',
      ].join('\n'),
    );

    await writeFile(factoryBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${callsLog}"\n`, {
      mode: 0o755,
    });
    await writeFile(path.join(binDir, 'systemd-run'), '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755,
    });
    await writeFile(path.join(binDir, 'systemctl'), '#!/usr/bin/env bash\necho active\nexit 0\n', {
      mode: 0o755,
    });
  }

  const oldPath = process.env.PATH;

  process.env.PATH = `${binDir}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });

  const config = {
    rootDir: root,
    dataHome: path.join(root, 'data'),
    factoryHome: root,
    factoryBin,
    factoryConfigRoot: path.join(root, 'config'),
    factoryControlDir: controlDir,
    routesDir,
    ticketsDir: path.join(root, 'tickets'),
    stateDir,
    profilesDir,
    factoryProfile: 'demo',
    sandboxDownCmd: '',
  };
  const adapter = new FactoryStateAdapter({
    stateDir,
    routesDir,
    profilesDir,
    controlDir,
  });

  if (!rootDirectory) {
    t.after(async () => {
      await rm(root, {
        recursive: true,
        force: true,
      });
    });
  }

  return {
    root,
    stateDir,
    controlDir,
    routesDir,
    config,
    adapter,
    callsLog,
  };
}

// Синтетическое состояние воспроизводит trusted контракт движка во временном каталоге.
// Помощник не обращается к пользовательским прогонам или внешним аккаунтам.
export async function seedFactoryServer(t, fx) {
  const app = Fastify({ logger: false });

  await app.register(factoryModule, {
    factoryState: fx.adapter,
    config: fx.config,
    prefs: { read: () => ({}) },
    tracker: null,
    analyzer: {
      readClarifications: async () => null,
      readOpenQuestions: async () => null,
    },
  });
  await app.ready();
  t.after(async () => app.close());

  return app;
}

// Смена revision оставляет тот же node, проверяя защиту от повторного захода ворот.
// Runtime публикуется по правилам checksum, а не через provider-writable registry.
export async function advanceFactory(fx, sequence = 9) {
  const file = path.join(
    fx.controlDir,
    'protocol-v2',
    'tasks',
    't7',
    'attempts',
    ATTEMPT,
    'stage-results',
    'runtime.json',
  );

  await chmod(file, 0o600);
  await writeFile(
    file,
    runtimeEnvelope(
      stageRuntime({
        node: 'gate_accept',
        state: 'paused',
        sequence,
      }),
    ),
  );
  await chmod(file, 0o400);
}

/**
 * Настоящий административный API работает во временных каталогах.
 * Подменяются внешние исполнитель, портал и CLI; доступ выдаётся тестовым CLI-токеном.
 *
 * @param {{ after: (callback: () => Promise<void> | void) => unknown }} t
 * @param {{ rootDirectory?: string | null }} options
 */
export async function createMobileSeed(t, { rootDirectory = null } = {}) {
  const cliToken = randomBytes(32).toString('hex');
  const cleanup = [];
  /** @type {MobileService | undefined} */
  let service;

  t.after(async () => {
    await service?.close();

    for (const callback of cleanup) {
      await callback();
    }
  });

  const scope = { after: (callback) => cleanup.unshift(callback) };
  const fx = await seedFactory(scope, {
    rootDirectory,
    cursor: {
      node: 'gate_accept',
      state: 'paused',
    },
  });
  const controlled = controlledExecutor();
  const tasks = [
    {
      task: '7',
      title: 'Синтетическая задача',
      profile: 'demo',
      attempt: ATTEMPT,
      stages: {
        BUILD: 'done',
        GATE_ACCEPT: 'wait',
      },
      stalledHuman: true,
      updatedAt: 1760000000000,
    },
  ];
  const graph = {
    route: 'feature',
    keys: {
      build: 'BUILD',
      gate_accept: 'GATE_ACCEPT',
    },
    statuses: {
      build: 'done',
      gate_accept: 'wait',
    },
    pos: {
      build: [0, 0],
      gate_accept: [0, 1],
    },
    nodes: {
      build: ['agent', 'Сборка'],
      gate_accept: ['gate', 'Приёмка'],
    },
  };

  fx.adapter.listTasks = async () => tasks;
  fx.adapter.getTaskDetail = async () => tasks[0];
  fx.adapter.getTaskGraph = async () => graph;
  await writeFile(path.join(fx.stateDir, 't7.report.md'), 'Полное основание приёмки\n');
  await writeFile(path.join(fx.stateDir, 't7.plan.md'), 'Полный план\n');

  const b24 = {
    getDashboard: async () => ({
      tasks: [
        {
          id: 7,
          title: 'Задача Б24',
          status: 3,
          statusLabel: 'В работе',
          deadlineRaw: '',
          priority: 1,
          responsible: 'Исполнитель',
        },
      ],
    }),
    taskDetail: async () => ({
      id: 7,
      title: 'Задача Б24',
      status: 3,
      description: '<b>Простой текст</b>',
      deadline: '',
      responsible: 'Исполнитель',
    }),
  };
  const core = await chatAppFixture(scope, {
    root: fx.root,
    executor: controlled.executor,
    withSsePlugin: true,
    extraRoutes: async (app) => {
      await app.register(authPlugin, {
        internalToken: 'test',
        cliToken,
        authStore: {
          isConfigured: () => true,
          isValidSession: () => false,
        },
      });
      await app.register(factoryModule, {
        factoryState: fx.adapter,
        config: fx.config,
        prefs: { read: () => ({}) },
        tracker: null,
        analyzer: {
          readClarifications: async () => null,
          readOpenQuestions: async () => null,
        },
      });
      await app.register(trackerModule, { tracker: b24 });

      // Каталог стенда соответствует управляемому исполнителю и не запускает discovery.
      app.get('/api/providers', async () => ({
        providers: [{
          id: 'test-provider',
          name: 'Тестовый исполнитель',
          chatEnabled: true,
          available: true,
          capabilities: { chatAutoCompact: false },
          models: [{
            id: 'test-model',
            name: 'Тестовая модель',
            efforts: [],
            contextRuntimeOnly: true,
          }],
        }],
      }));
      app.get('/api/projects', async () => ({ projects: [] }));

      service = new MobileService({
        directory: path.join(fx.root, 'mobile'),
        vpnGate: async () => true,
      });
      await app.register(mobileModule, { service });
    },
  });

  if (!rootDirectory) {
    const saved = await core.app.inject({
      method: 'PUT',
      url: '/api/chat/store/chat',
      headers: { 'x-grigdesk-internal': 'test' },
      payload: {
        chat: {
          id: 'integration-chat',
          title: 'Чат интеграции',
          modelRef: {
            provider: 'test-provider',
            model: 'test-model',
          },
          model: 'test-model',
          messages: [],
          createdAt: Date.now(),
        },
      },
    });

    assert.equal(saved.statusCode, 200, saved.body);
  }

  await core.app.ready();
  await service.start();

  const status = await service.status();

  assert.equal(typeof status.server.fp, 'string', JSON.stringify(status));
  assert.equal(Array.isArray(status.relays), true);

  return {
    ...fx,
    ...controlled,
    core: core.app,
    service,
    cliToken,
    tasks,
    graph,
  };
}
