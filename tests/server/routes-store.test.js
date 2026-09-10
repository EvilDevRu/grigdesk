import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  hashRoutesBytes,
  RoutesStore,
} from '../../server/src/modules/routes/store.ts';
import {
  validatePromptFiles,
  validateRoute,
} from '../../server/src/modules/routes/schema.ts';
import { acquireKernelFileLock } from '../../server/src/lib/kernelLock.ts';

const PROFILE = 'demo-profile';

function stop(target = 'human') {
  return { stop: target };
}

function next(id) {
  return { next: id };
}

function agentNode({
  id,
  phase,
  runKey,
  blocks,
  requiredContext,
  on,
  filesystem = 'state-only',
}) {
  return {
    id,
    executor: 'agent',
    phase,
    runKey,
    emits: [],
    prompt: { blocks, requiredContext },
    policy: {
      filesystem,
      timeoutClass: 'standard',
      budgetClass: 'standard',
    },
    fanout: {
      mode: 'single',
      maxExecutors: 1,
      degrade: 'forbid',
    },
    retry: {
      noResult: 1,
      providerFailure: {
        attempts: 1,
        strategy: 'runner-failover',
      },
      productFailure: 0,
    },
    on,
  };
}

function routePrompts() {
  return {
    'prompts/instrument.base.md': 'Расставь минимальные диагностические логи.',
    'prompts/instrument.performance.md': 'Измерь каждый участок вычисления.\r\n',
    'prompts/retro.base.md': 'Зафиксируй полезный урок.',
  };
}

function routeDocument({ title = 'Диагностика' } = {}) {
  return {
    schema: 2,
    kind: 'route',
    profile: PROFILE,
    id: 'debug',
    title,
    entry: 'instrument',
    sequence: {
      main: ['instrument', 'check', 'gate_plan'],
      tail: ['retro'],
    },
    nodes: [
      agentNode({
        id: 'instrument',
        phase: 'main',
        runKey: 'INSTRUMENT',
        blocks: [
          { file: 'prompts/instrument.base.md' },
          {
            file: 'prompts/instrument.performance.md',
            when: {
              context: 'diagnosis.kind',
              equals: 'performance',
            },
          },
        ],
        requiredContext: ['task', 'diagnosis'],
        filesystem: 'transactional-write',
        on: {
          done: next('check'),
          skipped: stop(),
          failed: stop(),
          exhausted: stop(),
        },
      }),
      {
        id: 'check',
        executor: 'command',
        phase: 'main',
        runKey: 'CHECK',
        commandId: 'project-check',
        emits: ['check_status'],
        policy: {
          filesystem: 'state-only',
          timeoutClass: 'check',
          budgetClass: 'small',
        },
        fanout: {
          mode: 'single',
          maxExecutors: 1,
          degrade: 'forbid',
        },
        retry: {
          noResult: 0,
          providerFailure: {
            attempts: 0,
            strategy: 'none',
          },
          productFailure: 0,
        },
        on: {
          done: next('gate_plan'),
          skipped: stop(),
          failed: stop('failed'),
          exhausted: stop(),
        },
      },
      {
        id: 'check_status',
        executor: 'status',
        phase: 'main',
        key: 'CHECK_STATUS',
        owner: 'check',
      },
      {
        id: 'gate_plan',
        executor: 'gate',
        phase: 'main',
        runKey: 'GATE_PLAN',
        emits: [],
        on: {
          approved: next('retro'),
          rejected: {
            rewind: 'instrument',
            reset: ['instrument', 'check', 'gate_plan'],
          },
        },
      },
      agentNode({
        id: 'retro',
        phase: 'tail',
        runKey: 'RETRO',
        blocks: [{ file: 'prompts/retro.base.md' }],
        requiredContext: ['task'],
        on: {
          done: stop('done'),
          skipped: stop('done'),
          failed: stop(),
          exhausted: stop(),
        },
      }),
    ],
    escalation: [],
  };
}

function bootstrapPrompts() {
  return {
    'bootstrap/prompts/scout.base.md': 'Выбери маршрут только из закреплённого каталога.',
  };
}

function bootstrapDocument() {
  return {
    schema: 2,
    kind: 'bootstrap',
    profile: PROFILE,
    id: 'scout',
    entry: 'scout',
    sequence: {
      bootstrap: ['scout'],
    },
    nodes: [
      agentNode({
        id: 'scout',
        phase: 'bootstrap',
        runKey: 'SCOUT',
        blocks: [{ file: 'bootstrap/prompts/scout.base.md' }],
        requiredContext: ['task', 'routeCatalog'],
        on: {
          done: {
            escalate: {
              routes: ['debug'],
            },
          },
          skipped: stop(),
          failed: stop(),
          exhausted: stop(),
        },
      }),
    ],
    escalation: [
      {
        from: 'scout',
        allowedRoutes: ['debug'],
        requiresHumanWhenPinned: true,
      },
    ],
  };
}

function catalogDocument(routeHash) {
  return {
    schema: 2,
    profile: PROFILE,
    routes: {
      debug: routeHash,
    },
    bootstrap: {
      file: 'bootstrap/scout.json',
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseDir = path.join(root, 'routes');
  return {
    root,
    baseDir,
    store: new RoutesStore({ baseDir }),
  };
}

async function publishRoute(store, options) {
  return store.publishRoute(PROFILE, 'debug', {
    route: routeDocument(options),
    prompts: routePrompts(),
  });
}

async function publishCatalog(store, routeHash, expectedCatalogHash) {
  return store.publishCatalog(PROFILE, {
    catalog: catalogDocument(routeHash),
    bootstrap: bootstrapDocument(),
    prompts: bootstrapPrompts(),
  }, { expectedCatalogHash });
}

test('ROUTES-V2-01: route bundle публикуется целиком и повтор идемпотентен', async (t) => {
  const { baseDir, store } = await fixture(t);

  const first = await publishRoute(store);
  const second = await publishRoute(store);

  assert.match(first.routeHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(second, {
    routeHash: first.routeHash,
    created: false,
  });
  assert.equal(first.created, true);

  const revisionDir = path.join(
    baseDir,
    PROFILE,
    'debug',
    'revisions',
    first.routeHash,
  );
  const manifestBytes = await readFile(path.join(revisionDir, 'manifest.json'));
  assert.equal(hashRoutesBytes(manifestBytes), first.routeHash);
  const manifest = JSON.parse(manifestBytes);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    [
      'prompts/instrument.base.md',
      'prompts/instrument.performance.md',
      'prompts/retro.base.md',
      'route.json',
    ],
  );
  assert.equal(
    (await readdir(path.dirname(revisionDir))).some((name) => name.startsWith('.tmp-')),
    false,
  );

  const read = await store.readRoute(PROFILE, 'debug', first.routeHash);
  assert.deepEqual(read.route, routeDocument());
  assert.equal(
    read.prompts['prompts/instrument.performance.md'],
    'Измерь каждый участок вычисления.\n',
  );
});

test('ROUTES-V2-02: catalog, bootstrap и current образуют одну проверяемую ревизию', async (t) => {
  const { baseDir, store } = await fixture(t);
  const route = await publishRoute(store);

  const first = await publishCatalog(store, route.routeHash, null);
  const repeated = await publishCatalog(store, route.routeHash, null);

  assert.equal(first.created, true);
  assert.equal(first.currentChanged, true);
  assert.deepEqual(repeated, {
    catalogHash: first.catalogHash,
    created: false,
    currentChanged: false,
  });

  const current = await store.readCurrent(PROFILE);
  assert.equal(current.catalogHash, first.catalogHash);
  assert.deepEqual(current.catalog, catalogDocument(route.routeHash));
  assert.deepEqual(current.bootstrap, bootstrapDocument());
  assert.equal(
    current.prompts['bootstrap/prompts/scout.base.md'],
    'Выбери маршрут только из закреплённого каталога.\n',
  );

  const pointer = JSON.parse(await readFile(
    path.join(baseDir, PROFILE, 'catalog', 'current.json'),
    'utf8',
  ));
  assert.deepEqual(pointer, {
    catalogHash: first.catalogHash,
    schema: 2,
  });
});

test('ROUTES-V2-03: stale CAS не перетирает более новую ревизию', async (t) => {
  const { store } = await fixture(t);
  const route1 = await publishRoute(store, { title: 'Версия 1' });
  const catalog1 = await publishCatalog(store, route1.routeHash, null);

  const route2 = await publishRoute(store, { title: 'Версия 2' });
  const catalog2 = await publishCatalog(store, route2.routeHash, catalog1.catalogHash);

  const route3 = await publishRoute(store, { title: 'Версия 3' });
  await assert.rejects(
    publishCatalog(store, route3.routeHash, catalog1.catalogHash),
    (error) => (
      error?.code === 'ROUTES_V2_STALE_REVISION'
      && error.details.currentCatalogHash === catalog2.catalogHash
    ),
  );
  assert.equal((await store.readCurrent(PROFILE)).catalogHash, catalog2.catalogHash);
});

test('ROUTES-V2-04: конкурирующие CAS дают ровно одного победителя', async (t) => {
  const { baseDir, store } = await fixture(t);
  const rivalStore = new RoutesStore({ baseDir });
  const route1 = await publishRoute(store, { title: 'Основа' });
  const catalog1 = await publishCatalog(store, route1.routeHash, null);
  const route2 = await publishRoute(store, { title: 'Ветка A' });
  const route3 = await publishRoute(store, { title: 'Ветка B' });

  const results = await Promise.allSettled([
    publishCatalog(store, route2.routeHash, catalog1.catalogHash),
    publishCatalog(rivalStore, route3.routeHash, catalog1.catalogHash),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'ROUTES_V2_STALE_REVISION');
  assert.equal(
    (await store.readCurrent(PROFILE)).catalogHash,
    results.find((result) => result.status === 'fulfilled').value.catalogHash,
  );
});

test('ROUTES-V2-05: изменение prompt или manifest обнаруживается как tampering', async (t) => {
  const { baseDir, store } = await fixture(t);
  const route = await publishRoute(store);
  const revisionDir = path.join(
    baseDir,
    PROFILE,
    'debug',
    'revisions',
    route.routeHash,
  );

  await writeFile(
    path.join(revisionDir, 'prompts', 'instrument.base.md'),
    'Незаметная подмена\n',
  );
  await assert.rejects(
    store.readRoute(PROFILE, 'debug', route.routeHash),
    (error) => error?.code === 'ROUTES_V2_TAMPERED',
  );

  const other = await publishRoute(store, { title: 'Другой manifest' });
  const manifestPath = path.join(
    baseDir,
    PROFILE,
    'debug',
    'revisions',
    other.routeHash,
    'manifest.json',
  );
  await writeFile(manifestPath, `${await readFile(manifestPath, 'utf8')}\n`);
  await assert.rejects(
    store.readRoute(PROFILE, 'debug', other.routeHash),
    (error) => error?.code === 'ROUTES_V2_TAMPERED',
  );
});

test('ROUTES-V2-06: catalog read проверяет и все закреплённые route bundles', async (t) => {
  const { baseDir, store } = await fixture(t);
  const route = await publishRoute(store);
  const catalog = await publishCatalog(store, route.routeHash, null);
  const promptPath = path.join(
    baseDir,
    PROFILE,
    'debug',
    'revisions',
    route.routeHash,
    'prompts',
    'retro.base.md',
  );
  await writeFile(promptPath, 'Подмена\n');

  await assert.rejects(
    store.readCatalog(PROFILE, catalog.catalogHash),
    (error) => error?.code === 'ROUTES_V2_TAMPERED',
  );
  await assert.rejects(
    store.readCurrent(PROFILE),
    (error) => error?.code === 'ROUTES_V2_TAMPERED',
  );
});

test('ROUTES-V2-07: traversal и небезопасные prompt paths отклоняются', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.publishRoute('../escape', 'debug', {
      route: routeDocument(),
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_PATH_TRAVERSAL',
  );
  await assert.rejects(
    store.publishRoute(PROFILE, '../debug', {
      route: routeDocument(),
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_PATH_TRAVERSAL',
  );
  await assert.rejects(
    store.publishRoute(PROFILE, 'Debug', {
      route: routeDocument(),
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_INVALID_ID',
  );
  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: routeDocument(),
      prompts: {
        ...routePrompts(),
        'prompts/../outside.md': 'Нельзя',
      },
    }),
    (error) => error?.code === 'ROUTES_V2_PATH_TRAVERSAL',
  );
  await assert.rejects(
    store.readRoute(PROFILE, 'debug', '../../etc/passwd'),
    (error) => error?.code === 'ROUTES_V2_PATH_TRAVERSAL',
  );
});

test('ROUTES-V2-08: route запрещает model policy и произвольный язык when', async (t) => {
  const { store } = await fixture(t);
  const withModel = routeDocument();
  withModel.nodes[0].model = 'opus';
  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: withModel,
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_FORBIDDEN_FIELD',
  );

  const withScript = routeDocument();
  withScript.nodes[0].prompt.blocks[1].when.script = 'return true';
  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: withScript,
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_INVALID_SCHEMA',
  );
});

test('ROUTES-V2-08A: productFailure не дублирует failed перед rewind', async (t) => {
  const { store } = await fixture(t);
  const valid = routeDocument({ title: 'Самоисправление текущего узла' });
  valid.nodes.find((node) => node.id === 'instrument').retry.productFailure = 1;
  await assert.doesNotReject(store.publishRoute(PROFILE, 'debug', {
    route: valid,
    prompts: routePrompts(),
  }));

  const broken = routeDocument({ title: 'Повтор проверяющего без нового входа' });
  const retro = broken.nodes.find((node) => node.id === 'retro');
  retro.retry.productFailure = 1;
  retro.on.failed = {
    rewind: 'instrument',
    reset: ['instrument', 'check', 'gate_plan', 'retro'],
  };
  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: broken,
      prompts: routePrompts(),
    }),
    (error) => (
      error?.code === 'ROUTES_V2_INVALID_SCHEMA'
      && error.details?.path === 'machine.nodes.retro.retry.productFailure'
      && /productFailure должен быть 0/u.test(error.message)
    ),
  );

  const promptFiles = validatePromptFiles(routePrompts(), { prefix: 'prompts/' });
  assert.doesNotThrow(() => validateRoute(broken, {
    profile: PROFILE,
    routeId: 'debug',
    promptFiles,
    allowLegacyProductFailureRewind: true,
  }));
});

test('ROUTES-V2-08B: typed owner routes и fanout имеют закрытую безопасную схему', () => {
  const promptFiles = validatePromptFiles(routePrompts(), { prefix: 'prompts/' });
  const valid = routeDocument({ title: 'Typed owner routing' });
  valid.nodes.find((node) => node.id === 'check').onFailure = {
    build: {
      rewind: 'instrument',
      reset: ['instrument', 'check'],
    },
    tests: stop(),
    environment: stop(),
    plan: stop(),
    human: stop(),
  };
  assert.doesNotThrow(() => validateRoute(valid, {
    profile: PROFILE,
    routeId: 'debug',
    promptFiles,
  }));

  const missingOwner = structuredClone(valid);
  delete missingOwner.nodes.find((node) => node.id === 'check').onFailure.human;
  assert.throws(
    () => validateRoute(missingOwner, { profile: PROFILE, routeId: 'debug', promptFiles }),
    (error) => (
      error?.code === 'ROUTES_V2_INVALID_SCHEMA'
      && error.details?.path === 'machine.nodes[1].onFailure.human'
    ),
  );

  const writableParallel = routeDocument();
  writableParallel.nodes.find((node) => node.id === 'instrument').fanout = {
    mode: 'parallel', maxExecutors: 3, degrade: 'allow-single',
  };
  assert.throws(
    () => validateRoute(writableParallel, { profile: PROFILE, routeId: 'debug', promptFiles }),
    (error) => (
      error?.code === 'ROUTES_V2_INVALID_SCHEMA'
      && error.details?.path === 'machine.nodes[0].fanout'
    ),
  );

  const commandParallel = routeDocument();
  commandParallel.nodes.find((node) => node.id === 'check').fanout = {
    mode: 'parallel', maxExecutors: 2, degrade: 'allow-single',
  };
  assert.throws(
    () => validateRoute(commandParallel, { profile: PROFILE, routeId: 'debug', promptFiles }),
    (error) => (
      error?.code === 'ROUTES_V2_INVALID_SCHEMA'
      && error.details?.path === 'machine.nodes[1].fanout'
    ),
  );

  const commandRetry = routeDocument();
  commandRetry.nodes.find((node) => node.id === 'check').retry.noResult = 1;
  assert.throws(
    () => validateRoute(commandRetry, { profile: PROFILE, routeId: 'debug', promptFiles }),
    (error) => (
      error?.code === 'ROUTES_V2_INVALID_SCHEMA'
      && error.details?.path === 'machine.nodes[1].retry'
    ),
  );
});

test('ROUTES-V2-09: status обязан иметь взаимную связь owner ↔ emits', async (t) => {
  const { store } = await fixture(t);
  const broken = routeDocument();
  broken.nodes.find((node) => node.id === 'check').emits = [];

  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: broken,
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_INVALID_SCHEMA',
  );
});

test('ROUTES-V2-10: catalog не публикует отсутствующую route revision', async (t) => {
  const { store } = await fixture(t);
  const missingHash = 'a'.repeat(64);

  await assert.rejects(
    publishCatalog(store, missingHash, null),
    (error) => error?.code === 'ROUTES_V2_NOT_FOUND',
  );
  assert.equal(await store.readCurrent(PROFILE), null);
});

test('ROUTES-V2-11: symlink внутри опубликованного bundle считается tampering', async (t) => {
  const { baseDir, root, store } = await fixture(t);
  const route = await publishRoute(store);
  const promptPath = path.join(
    baseDir,
    PROFILE,
    'debug',
    'revisions',
    route.routeHash,
    'prompts',
    'retro.base.md',
  );
  const outside = path.join(root, 'outside.md');
  await writeFile(outside, 'Снаружи\n');
  await unlink(promptPath);
  await symlink(outside, promptPath);

  await assert.rejects(
    store.readRoute(PROFILE, 'debug', route.routeHash),
    (error) => error?.code === 'ROUTES_V2_TAMPERED',
  );
});

test('ROUTES-V2-12: current можно CAS-откатить только на целый проверенный catalog', async (t) => {
  const { store } = await fixture(t);
  const route1 = await publishRoute(store, { title: 'Версия 1' });
  const catalog1 = await publishCatalog(store, route1.routeHash, null);
  const route2 = await publishRoute(store, { title: 'Версия 2' });
  const catalog2 = await publishCatalog(store, route2.routeHash, catalog1.catalogHash);

  assert.deepEqual(
    await store.compareAndSwapCurrent(
      PROFILE,
      catalog1.catalogHash,
      { expectedCatalogHash: catalog2.catalogHash },
    ),
    { changed: true, catalogHash: catalog1.catalogHash },
  );
  assert.equal((await store.readCurrent(PROFILE)).catalogHash, catalog1.catalogHash);

  await assert.rejects(
    store.compareAndSwapCurrent(
      PROFILE,
      'b'.repeat(64),
      { expectedCatalogHash: catalog1.catalogHash },
    ),
    (error) => error?.code === 'ROUTES_V2_NOT_FOUND',
  );
});

test('ROUTES-V2-13: оставшийся lock-файл после crash не блокирует новый процесс', async (t) => {
  const { baseDir, store } = await fixture(t);
  const route = await publishRoute(store);
  const catalogDir = path.join(baseDir, PROFILE, 'catalog');
  await mkdir(catalogDir, { recursive: true });
  await writeFile(path.join(catalogDir, '.current.lock'), 'dead process\n');

  const catalog = await publishCatalog(store, route.routeHash, null);
  assert.match(catalog.catalogHash, /^[a-f0-9]{64}$/);
  assert.equal((await store.readCurrent(PROFILE)).catalogHash, catalog.catalogHash);
});

test('ROUTES-V2-14: kernel lock переживает конкуренцию и безопасно освобождается', async (t) => {
  const { baseDir, store } = await fixture(t);
  const route1 = await publishRoute(store, { title: 'Основа' });
  const catalog1 = await publishCatalog(store, route1.routeHash, null);
  const route2 = await publishRoute(store, { title: 'Следующая' });
  const lockPath = path.join(baseDir, PROFILE, 'catalog', '.current.lock');
  const held = await acquireKernelFileLock({ lockPath, timeoutMs: 100 });
  t.after(() => held.release());

  const contender = new RoutesStore({ baseDir, lockTimeoutMs: 20 });
  await assert.rejects(
    publishCatalog(contender, route2.routeHash, catalog1.catalogHash),
    (error) => error?.code === 'ROUTES_V2_LOCKED',
  );
  assert.equal((await store.readCurrent(PROFILE)).catalogHash, catalog1.catalogHash);

  await held.release();
  const catalog2 = await publishCatalog(contender, route2.routeHash, catalog1.catalogHash);
  assert.equal((await store.readCurrent(PROFILE)).catalogHash, catalog2.catalogHash);
});

test('ROUTES-V2-15: symlink в корне store не перенаправляет публикацию', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-routes-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  const baseDir = path.join(root, 'routes-link');
  await mkdir(outside);
  await symlink(outside, baseDir);
  const store = new RoutesStore({ baseDir });

  await assert.rejects(
    publishRoute(store),
    (error) => error?.code === 'ROUTES_V2_PATH_TRAVERSAL',
  );
  assert.deepEqual(await readdir(outside), []);
});

test('ROUTES-V2-16: rewind обязан сбрасывать весь непрерывный участок', async (t) => {
  const { store } = await fixture(t);
  const broken = routeDocument();
  broken.nodes.find((node) => node.id === 'gate_plan').on.rejected.reset = [
    'instrument',
    'gate_plan',
  ];

  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: broken,
      prompts: routePrompts(),
    }),
    (error) => (
      error?.code === 'ROUTES_V2_INVALID_SCHEMA'
      && error.details.path.endsWith('.reset')
    ),
  );
});

test('ROUTES-V2-17: runKey и status key образуют единый уникальный реестр', async (t) => {
  const { store } = await fixture(t);
  const broken = routeDocument();
  broken.nodes.find((node) => node.id === 'check_status').key = 'INSTRUMENT';

  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: broken,
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_INVALID_SCHEMA',
  );
});

test('ROUTES-V2-19: id исполняемого узла точно выводится из runKey', async (t) => {
  const { store } = await fixture(t);
  const broken = routeDocument();
  broken.nodes.find((node) => node.id === 'instrument').runKey = 'TRACE';

  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: broken,
      prompts: routePrompts(),
    }),
    (error) => (
      error?.code === 'ROUTES_V2_INVALID_SCHEMA'
      && error.details.path.endsWith('.runKey')
    ),
  );
});

test('ROUTES-V2-20: неизвестный timeoutClass и скрытая delivery-capability запрещены', async (t) => {
  const { store } = await fixture(t);
  const unknownTimeout = routeDocument();
  unknownTimeout.nodes.find((node) => node.id === 'instrument').policy.timeoutClass = 'quantum';
  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: unknownTimeout,
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_INVALID_SCHEMA',
  );

  const hiddenDelivery = routeDocument();
  hiddenDelivery.nodes.find((node) => node.id === 'retro').prompt.requiredContext.push('delivery');
  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: hiddenDelivery,
      prompts: routePrompts(),
    }),
    (error) => error?.code === 'ROUTES_V2_INVALID_SCHEMA',
  );

  const publishRoute = routeDocument();
  publishRoute.sequence.tail.unshift('ship');
  publishRoute.nodes.find((node) => node.id === 'gate_plan').on.approved = next('ship');
  const ship = agentNode({
    id: 'ship',
    phase: 'tail',
    runKey: 'SHIP',
    blocks: [{ file: 'prompts/ship.base.md' }],
    requiredContext: ['task', 'delivery'],
    filesystem: 'workspace-write',
    on: {
      done: next('retro'),
      skipped: stop(),
      failed: stop(),
      exhausted: stop(),
    },
  });
  ship.policy.timeoutClass = 'delivery';
  publishRoute.nodes.splice(-1, 0, ship);
  publishRoute.nodes.find((node) => node.id === 'retro').prompt.requiredContext.push('delivery');
  await assert.rejects(
    store.publishRoute(PROFILE, 'debug', {
      route: publishRoute,
      prompts: {
        ...routePrompts(),
        'prompts/ship.base.md': 'Опубликуй только принятый результат.',
      },
    }),
    (error) => error?.code === 'ROUTES_V2_INVALID_SCHEMA',
  );
});

test('ROUTES-V2-18: escalation любой route должна ссылаться на catalog', async (t) => {
  const { store } = await fixture(t);
  const broken = routeDocument();
  const instrument = broken.nodes.find((node) => node.id === 'instrument');
  instrument.on.failed = {
    escalate: {
      routes: ['missing'],
    },
  };
  broken.escalation = [
    {
      from: 'instrument',
      allowedRoutes: ['missing'],
      requiresHumanWhenPinned: false,
    },
  ];
  const route = await store.publishRoute(PROFILE, 'debug', {
    route: broken,
    prompts: routePrompts(),
  });

  await assert.rejects(
    publishCatalog(store, route.routeHash, null),
    (error) => (
      error?.code === 'ROUTES_V2_INVALID_SCHEMA'
      && error.details.routeId === 'missing'
    ),
  );
  assert.equal(await store.readCurrent(PROFILE), null);
});
