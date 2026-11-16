import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const source = (relative) => new URL(`../../../${relative}`, import.meta.url).href;
const requireFromServer = createRequire(source('server/package.json'));
const Fastify = requireFromServer('fastify');
const active = new Map();
const initialPath = process.env.PATH;
const exists = (file) => access(file).then(() => true, () => false);

// Подменяется доступ к личным профилям, но rollback остаётся наблюдаемым.
// Настоящие HTTP-handler, launcher, descriptor и guard работают без замены.
mock.module(source('server/src/lib/accessProfiles/pipeline.ts'), {
  namedExports: {
    async preparePipelineAccess(service, config) {
      const observed = active.get(config.stateDir);

      observed.accessCalls += 1;

      return {
        env: {},
        environments: { kimi: { KIMI_CODE_HOME: path.join(observed.root, 'access') } },
        keys: [],
        rollback: async () => {
          observed.rollbacks += 1;
        },
      };
    },
  },
});

// Внешние shell и inventory контролируются фикстурой, личный HOME не читается.
// Builder сохраняет настоящий путь выбранной установки и причину недоступности.
mock.module(source('server/src/lib/providerInstall/userCliEnvironment.ts'), {
  namedExports: {
    async resolveUserCliEnvironment() {
      return { env: {}, cli: { kind: 'missing', path: '' } };
    },
  },
});
mock.module(source('server/src/lib/providerInstall/inventory.ts'), {
  namedExports: {
    /**
     * Выбранная копия меняет готовность между запросами без смены HTTP-сервера.
     * Путь присутствует даже при missing: проверяем сохранение точной диагностики.
     */
    async discoverExternalCli(input) {
      const observed = [...active.values()].find((entry) => entry.building);
      const ready = observed.mode === 'ready';

      assert.equal(input.providerId, 'kimi');

      return {
        installations: [{
          installationId: 'selected',
          resourceKey: 'fixture-kimi',
          path: observed.selectedBin,
          realpath: ready ? observed.selectedBin : null,
          state: ready ? 'ready' : observed.mode === 'broken' ? 'broken' : 'missing',
        }],
        selectedId: 'selected',
        terminalId: ready ? 'selected' : null,
      };
    },
  },
});

const realBuilder = await import(source('server/src/lib/providerInstall/factoryExternalCli.ts'));

// Обёртка даёт независимый отказ builder и артефакты, появившиеся во время подготовки.
// Штатный missing/ready проходит настоящий builder и его проверку в launcher.
mock.module(source('server/src/lib/providerInstall/factoryExternalCli.ts'), {
  namedExports: {
    factoryExternalCliDescriptorPath: realBuilder.factoryExternalCliDescriptorPath,
    /**
     * Настоящий builder получает только фикстурного исполнителя без доступа к HOME.
     * Ошибка либо остаток вводятся после preflight, чтобы проверить финальный proof.
     */
    async buildFactoryExternalCliDescriptor(input) {
      const observed = [...active.values()].find((entry) =>
        input.descriptorPath.startsWith(`${entry.stateDir}/`));

      observed.descriptorCalls += 1;
      observed.building = true;

      if (observed.mode === 'throw') {
        throw new Error(observed.detailedReason);
      }

      const descriptor = await realBuilder.buildFactoryExternalCliDescriptor({
        ...input,
        adapters: new Map([['kimi', input.adapters.get('kimi')]]),
      });

      observed.building = false;
      observed.descriptorPath = input.descriptorPath;
      await observed.injectArtifact();

      return descriptor;
    },
  },
});

const { default: factoryModule } = await import(source('server/src/modules/factory/index.ts'));

/**
 * Каждый HTTP-сервер получает отдельную папку, профиль и подменные команды регистрации.
 * Движок и модели не запускаются; счётчик отражает только передачу в systemd-run.
 */
async function fixture(t, { mode = 'missing', artifact = '', withSlots = false, failedUnit = false } = {}) {
  const root = await mkdtemp(path.join(process.env.GRIGDESK_ARTIFACTS_DIR || os.tmpdir(), 'launch-prep-'));
  const stateDir = path.join(root, 'state');
  const binDir = path.join(root, 'bin');
  const profilesDir = path.join(root, 'profiles');
  const observed = {
    root,
    stateDir,
    mode,
    descriptorCalls: 0,
    accessCalls: 0,
    rollbacks: 0,
    selectedBin: path.join(binDir, 'kimi'),
    detailedReason: 'Kimi: выбранная копия CLI /fixture/npm-prefix/bin/kimi недоступна (ENOENT)',
  };
  const capture = [];

  active.set(stateDir, observed);
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(path.join(profilesDir, 'demo'), { recursive: true }),
  ]);
  await writeFile(observed.selectedBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(profilesDir, 'demo', 'profile.sh'),
    `profile_repositories() { printf 'demo\\t${root}/src\\t${root}/work\\n'; }\n`);

  const slots = withSlots ? {
    supported: true,
    free: [1],
    used: [],
  } : { supported: false };
  const factoryBin = path.join(binDir, 'factory');

  await writeFile(factoryBin, `#!/bin/bash
case "$1" in
  check) echo 'OK delivery=disabled instrumentation=disabled'; exit 0 ;;
  slots) echo '${JSON.stringify(slots)}'; exit 0 ;;
esac
exit 91
`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemd-run'), `#!/bin/bash
if [ "$1" = '--version' ]; then echo 'systemd (fixture)'; exit 0; fi
printf 'registered\\n' >> '${root}/systemd.calls'
${failedUnit ? `echo '[FACTORY_ERROR=runner_preflight_failed]' >> '${stateDir}/t4.launch.log'` : ''}
exit 0
`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemctl'),
    failedUnit ? '#!/bin/bash\necho inactive\nexit 3\n' : '#!/bin/bash\necho active\nexit 0\n',
    { mode: 0o755 });

  process.env.PATH = `${binDir}:${initialPath}`;

  const config = {
    rootDir: repository,
    dataHome: path.join(root, 'home'),
    factoryHome: path.join(root, 'engine'),
    factoryBin,
    factoryConfigRoot: path.join(root, 'config'),
    factoryControlDir: path.join(root, 'control'),
    routesDir: path.join(root, 'routes'),
    ticketsDir: path.join(root, 'tickets'),
    grigdeskTasksPath: path.join(root, 'tasks.json'),
    stateDir,
    profilesDir,
    factoryProfile: 'demo',
    accessProfiles: { adaptersOf: async () => new Map() },
  };
  const registryFile = path.join(stateDir, 't4.pipeline');
  const attemptRoot = path.join(config.factoryControlDir, 'protocol-v2', 'tasks', 't4');
  const slotFile = path.join(stateDir, 'slots', 't4.json');

  observed.injectArtifact = async () => {
    if (artifact === 'registry') {
      await writeFile(registryFile, '{}');
    } else if (artifact === 'registry-error') {
      await mkdir(registryFile);
    } else if (artifact === 'attempt') {
      const directory = path.join(attemptRoot, 'attempts', 'a_' + 'a'.repeat(32));

      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'attempt.json'), '{}');
    } else if (artifact === 'slot') {
      await writeFile(slotFile, JSON.stringify({
        task: '4',
        k: 1,
        at: Date.now(),
      }));
    } else if (artifact === 'control-error') {
      await writeFile(config.factoryControlDir, 'не каталог');
    }
  };

  const app = Fastify({
    logger: {
      level: 'info',
      base: null,
      timestamp: false,
      stream: {
        write(line) {
          capture.push(JSON.parse(line));
        },
      },
    },
  });

  await app.register(factoryModule, {
    config,
    factoryState: {
      discoverProfiles: () => ['demo'],
      primaryProfile: async () => 'demo',
      readRegistry: async () => ({ registry: JSON.parse(await readFile(registryFile, 'utf8')) }),
      isDaemonAlive: () => false,
      catalog: async () => ({
        routes: ['feature'],
        catalogHash: 'b'.repeat(64),
        routeOptions: { feature: { deliveryMode: 'disabled', instrumentationMode: 'disabled' } },
      }),
    },
    prefs: { read: () => ({}) },
    tracker: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
    inspectLaunchState: async () => ({
      kind: 'absent',
      identity: null,
      origin: null,
    }),
  });
  await app.ready();
  t.after(async () => {
    process.env.PATH = initialPath;
    await app.close();
    active.delete(stateDir);
    await rm(root, { recursive: true, force: true });
  });

  observed.capture = capture;
  observed.launch = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/4/launch',
      payload: {
        profile: 'demo',
        route: 'feature',
        title: 'Проверка подготовки CLI',
        description: 'Отказ выбранной копии Kimi до запуска.',
        sourceUrl: 'https://example.test/tasks/4',
        acceptanceCriteria: [],
      },
    });

    return { status: response.statusCode, body: response.json() };
  };
  observed.artifacts = async () => ({
    registry: await exists(registryFile),
    attempt: await exists(attemptRoot),
    slot: await exists(slotFile),
    registrations: (await readFile(path.join(root, 'systemd.calls'), 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).length,
  });

  return observed;
}

for (const withSlots of [false, true]) {
  test(`подготовка CLI: 500 → 200 → 409, слоты=${withSlots}`, async (t) => {
    const f = await fixture(t, { withSlots });
    const first = await f.launch();

    assert.equal(first.status, 500);
    assert.equal(first.body.outcome, 'invalid');
    assert.match(first.body.message, /Kimi.*kimi/);
    assert.ok(first.body.message.includes(f.selectedBin));
    assert.match(first.body.message, /cli_missing/);
    assert.deepEqual(await f.artifacts(), {
      registry: false,
      attempt: false,
      slot: false,
      registrations: 0,
    });
    assert.equal(f.rollbacks, 1);

    const descriptor = JSON.parse(await readFile(f.descriptorPath, 'utf8'));

    assert.equal(descriptor.unavailable.kimi, 'cli_missing');
    assert.equal(descriptor.unavailableBins.kimi, f.selectedBin);
    assert.ok(f.capture.some((entry) => entry.level === 50 && entry.reason === first.body.message));

    f.mode = 'ready';

    const second = await f.launch();
    const third = await f.launch();

    assert.equal(second.status, 200, JSON.stringify(second));
    assert.equal(second.body.outcome, 'started');
    assert.equal(third.status, 409);
    assert.equal(third.body.error, 'run_exists');
    assert.equal((await f.artifacts()).registrations, 1);
    assert.equal(f.descriptorCalls, 2);
    assert.equal(f.accessCalls, 2);
    assert.equal(f.rollbacks, 1);
  });
}

test('повреждённая выбранная копия названа в ответе и серверном журнале', async (t) => {
  const f = await fixture(t, { mode: 'broken' });
  const response = await f.launch();

  assert.equal(response.status, 500);
  assert.match(response.body.message, /Kimi.*cli_broken/);
  assert.ok(response.body.message.includes(f.selectedBin));
  assert.ok(f.capture.some((entry) => entry.reason === response.body.message));
});

test('исходная причина builder сохраняется в ответе и серверном журнале', async (t) => {
  const f = await fixture(t, { mode: 'throw' });
  const response = await f.launch();

  assert.equal(response.status, 500);
  assert.ok(response.body.message.includes(f.detailedReason));
  assert.ok(f.capture.some((entry) => entry.reason?.includes(f.detailedReason)));
  assert.equal(f.rollbacks, 1);
});

for (const artifact of ['registry', 'attempt', 'slot', 'registry-error', 'control-error']) {
  test(`отказ подготовки с остатком или ошибкой чтения ${artifact} сохраняет pending`, async (t) => {
    const f = await fixture(t, { artifact });
    const first = await f.launch();

    f.mode = 'ready';

    const second = await f.launch();

    assert.equal(first.status, 500);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'run_exists');
    assert.equal(f.descriptorCalls, 1);
    assert.equal((await f.artifacts()).registrations, 0);
  });
}

test('успешная передача без identity сохраняет pending даже без артефактов', async (t) => {
  const f = await fixture(t, { mode: 'ready' });
  const first = await f.launch();
  const second = await f.launch();

  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, 'started');
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'run_exists');
  assert.deepEqual(await f.artifacts(), {
    registry: false,
    attempt: false,
    slot: false,
    registrations: 1,
  });
  assert.equal(f.descriptorCalls, 1);
});

test('invalid/runner_preflight_failed после регистрации сохраняет pending', async (t) => {
  const f = await fixture(t, { mode: 'ready', failedUnit: true });
  const first = await f.launch();
  const second = await f.launch();

  assert.equal(first.status, 500);
  assert.equal(first.body.outcome, 'invalid');
  assert.equal(first.body.error, 'runner_preflight_failed');
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'run_exists');
  assert.deepEqual(await f.artifacts(), {
    registry: false,
    attempt: false,
    slot: false,
    registrations: 1,
  });
});
