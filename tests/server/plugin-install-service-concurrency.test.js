import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { liveGroupMembers } from '../../server/src/lib/pluginInstall/workerIdentity.ts';
import { installError } from '../../server/src/lib/pluginInstall/errors.ts';
import { writeDurableFile } from '../../server/src/lib/durableFile.ts';
import { PluginInstallService } from '../../server/src/lib/pluginInstall/service.ts';
import { PluginSourceRegistry } from '../../server/src/lib/pluginInstall/sources.ts';
import { computePayloadDigest } from '../../server/src/lib/pluginInstall/payloadDigest.ts';
import { installedRecord } from './helpers/pluginInstallState.js';
import { mirrorPair } from './helpers/pluginMirrorFixture.js';
import { createPluginRepo } from './helpers/pluginRepo.js';
import { serviceFixture } from './helpers/pluginServiceFixture.js';

/**
 * Barrier даёт наблюдаемую точку удержания без проверки времени выполнения.
 * Release вызывается и в finally, чтобы assertion failure не подвешивал cleanup.
 */
function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

/**
 * Стратегия пишет реальный payload, но не использует сеть или процессы Git.
 * Counters относятся к интерфейсу source и доступны concurrency assertions.
 */
function controlledSource() {
  const calls = [];

  return {
    kind: 'mirror',
    calls,
    normalizeUrl: (url) => url,
    listVersions: async () => [{
      version: '1.1.0',
      tag: 'v1.1.0',
      sha: 'b'.repeat(40),
    }],
    fetch: async (request) => {
      calls.push(request);
      await mkdir(request.destination, { recursive: true });
      await writeFile(path.join(request.destination, 'plugin.json'),
        JSON.stringify({ id: 'demo', version: '1.1.0' }));
    },
    changes: async () => null,
    inspectInstalled: async (_dir, expected) => ({ sha: expected.sha, modified: false }),
  };
}

/**
 * Полный managed record связан с фактическими bytes собственного fixture.
 * Seed выполняется до recover, без правки cache сервиса из теста.
 */
async function seedManaged({ service, pluginsDir }) {
  const directory = path.join(pluginsDir, 'demo');

  await mkdir(directory);
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0' }));

  const record = installedRecord();

  record.source = { kind: 'mirror', url: 'mirror://fixture/demo' };
  record.payloadDigest = await computePayloadDigest(directory, []);
  await service.store.mutate((state) => {
    state.plugins.demo = record;
    state.nextRevision = 2;
  });
}

test('M27: simultaneous install/install и install/update имеют один admission до durable reservation',
  async (t) => {
    for (const mixed of [false, true]) {
      const source = controlledSource();
      const { service } = await serviceFixture(t, {
        sources: new PluginSourceRegistry([source]),
        seed: mixed ? seedManaged : undefined,
      });
      const entered = barrier();
      const gate = barrier();
      const original = service.store.mutate.bind(service.store);
      let admissions = 0;

      service.store.mutate = async (...args) => {
        admissions += 1;

        if (admissions === 1) {
          entered.release();
          await gate.promise;
        }

        return original(...args);
      };

      const first = service.startInstall({ url: 'mirror://fixture/demo' });

      await entered.promise;

      const second = (mixed ? service.startUpdate('demo')
        : service.startInstall({ url: 'mirror://fixture/demo' })).catch((error) => error);

      try {
        await Promise.resolve();
        assert.equal(admissions, 1, 'резервирование синхронно до store await');
      } finally {
        gate.release();
      }

      const job = await first;
      const rejected = await second;

      assert.equal(rejected.code, 'install_busy');
      await service.whenIdle();
      assert.equal(source.calls.length, 1);
      assert.equal((await service.currentJob()).id, job.id);
      assert.equal((await service.currentJob()).status, 'ready');
    }
  });

test('M28: late progress и stage A после cancel и admission B не меняют память или JSON B', async (t) => {
  const source = controlledSource();
  const { service, statePath } = await serviceFixture(t, { sources: new PluginSourceRegistry([source]) });
  const first = await service.startInstall({ url: 'mirror://fixture/demo' });
  const generation = service.generation;

  await service.whenIdle();
  await service.cancel(first.id);

  const entered = barrier();
  const held = barrier();
  const originalFetch = source.fetch;

  source.fetch = async (request) => {
    await originalFetch(request);
    entered.release();
    await held.promise;
  };

  const next = await service.startInstall({ url: 'mirror://fixture/demo' });

  await entered.promise;

  const memory = await service.currentJob();
  const disk = await readFile(statePath, 'utf8');

  try {
    source.calls[0].onProgress(77);
    assert.deepEqual(await service.currentJob(), memory, 'progress не меняет память B');
    await service.updateJob(first.id, generation, (job) => {
      job.stage = 'validating';
    });
    assert.deepEqual(await service.currentJob(), memory);
    assert.equal(await readFile(statePath, 'utf8'), disk);
    assert.equal((await service.currentJob()).id, next.id);
  } finally {
    held.release();
    await service.whenIdle();
  }
});

test('M29: failed state publication блокирует admission, сохраняет staging и не запускает writer',
  async (t) => {
  for (const duringPrepare of [false, true]) {
    const source = controlledSource();
    const entered = barrier();
    const hold = barrier();
    const originalFetch = source.fetch;

    source.fetch = async (request) => {
      await originalFetch(request);
      entered.release();
      await hold.promise;
    };

    const { service, statePath } = await serviceFixture(t, {
      sources: new PluginSourceRegistry([source]),
      blockedClose: true,
    });
    let published = 0;
    const originalWrite = service.store.options.write;

    if (!duringPrepare) {
      service.store.options.write = async () => {
        published += 1;

        throw Object.assign(new Error('fixture durable EIO'), { code: 'EIO' });
      };
      await assert.rejects(service.startInstall({ url: 'mirror://fixture/demo' }));
      assert.equal(published, 1);
      assert.equal(source.calls.length, 0);
    } else {
      await service.startInstall({ url: 'mirror://fixture/demo' });
      await entered.promise;
      service.store.options.write = async () => {
        published += 1;

        throw Object.assign(new Error('fixture durable EIO'), { code: 'EIO' });
      };
      hold.release();
      await service.whenIdle();

      const job = await service.currentJob();
      const packageFile = path.join(service.workDir, 'jobs', job.id, 'package/plugin.json');

      assert.equal(JSON.parse(await readFile(packageFile, 'utf8')).id, 'demo', 'при EIO нет cleanup');
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).workers, {});
    }

    assert.equal(service.health()?.code, 'recovery_required');
    await assert.rejects(service.startInstall({ url: 'mirror://fixture/demo' }),
      { code: 'recovery_required' });
    service.store.options.write = originalWrite;
    hold.release();
  }
});

test('M30: общий deadline и budget между npmDirs не допускают следующую команду и не меняют current',
  async (t) => {
    for (const deadline of [true, false]) {
      const source = controlledSource();
      const original = source.fetch;
      const npmCalls = [];

      source.fetch = async (request) => {
        await original(request);
        await writeFile(path.join(request.destination, 'plugin.json'), JSON.stringify({
          id: 'demo',
          version: '1.1.0',
          install: { npm: ['.', 'browser'] },
        }));

        for (const relative of ['.', 'browser']) {
          const directory = path.join(request.destination, relative);

          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, 'package.json'),
            JSON.stringify({ name: 'fixture', version: '1.0.0' }));
          await writeFile(path.join(directory, 'package-lock.json'),
            JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
        }
      };

      const fixture = await serviceFixture(t, {
        sources: new PluginSourceRegistry([source]),
        seed: seedManaged,
        stagingLimits: {
          maxBytes: 3000,
          minFreeBytes: 0,
          checkIntervalMs: 100,
        },
        runNpm: async (cwd, signal, budget) => {
          npmCalls.push(cwd);

          if (deadline) {
            t.mock.timers.tick(20 * 60 * 1000);
          } else {
            await writeFile(path.join(budget.root, 'npm-cache-quota'), Buffer.alloc(5000));
          }

          return {
            code: 0,
            signal: null,
            timedOut: false,
            aborted: signal.aborted,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            workspaceLimitExceeded: false,
          };
        },
      });
      const currentFile = path.join(fixture.pluginsDir, 'demo/plugin.json');
      const before = await readFile(currentFile, 'utf8');

      t.mock.timers.enable({ apis: ['setTimeout'] });
      await fixture.service.startUpdate('demo');
      await fixture.service.whenIdle();
      t.mock.timers.reset();

      const job = await fixture.service.currentJob();

      assert.equal(job.status, 'failed');
      assert.equal(job.error.code, deadline ? 'source_timeout' : 'workspace_limit');
      assert.equal(npmCalls.length, 1, 'вторая npmDir не допущена после общего предела');
      assert.equal(await readFile(currentFile, 'utf8'), before);
    }
  });

test('M31: второй сервис и настоящий process не пишут JSON без owner lock; close сохраняет inode',
  async (t) => {
    const source = controlledSource();
    const fixture = await serviceFixture(t, { sources: new PluginSourceRegistry([source]) });

    await fixture.service.startInstall({ url: 'mirror://fixture/demo' });
    await fixture.service.whenIdle();

    const before = await readFile(fixture.statePath, 'utf8');
    const lockPath = path.join(fixture.service.workDir, 'owner.lock');
    const identity = await lstat(lockPath);
    const options = {
      pluginsDir: fixture.pluginsDir,
      statePath: fixture.statePath,
      grigDeskVersion: '1.0.0',
      reservedIds: [],
    };
    const second = new PluginInstallService(options);
    const recovered = await second.recover();

    try {
      assert.equal(recovered.blockedIds, '*');
      assert.equal(recovered.error.code, 'recovery_required');
      assert.equal(await readFile(fixture.statePath, 'utf8'), before);
      await assert.rejects(second.startInstall({ url: 'file:///fixture.git' }),
        { code: 'recovery_required' });

      const file = fileURLToPath(new URL('./fixtures/plugin-service-process.mjs', import.meta.url));
      const child = fork(file, [JSON.stringify(options)], {
          execArgv: [],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
      const answer = once(child, 'message');
      const exit = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);

      try {
        const [message] = await answer;

        assert.equal(message.result.blockedIds, '*');
        assert.equal((await exit)[0], 0);
      } finally {
        clearTimeout(timer);

        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }

      assert.equal(await readFile(fixture.statePath, 'utf8'), before);
      assert.equal((await fixture.service.currentJob()).status, 'ready');
    } finally {
      await second.close();
    }

    await fixture.service.close();

    const successor = new PluginInstallService(options);

    try {
      assert.deepEqual((await successor.recover()).blockedIds, []);
      assert.equal((await lstat(lockPath)).ino, identity.ino);
    } finally {
      await successor.close();
    }
  });

test('M32: отсутствие binding запрещает apply/rollback до эффекта', async (t) => {
  const source = controlledSource();
  const { service, statePath } = await serviceFixture(t, {
    sources: new PluginSourceRegistry([source]),
    bind: false,
  });

  await service.startInstall({ url: 'mirror://fixture/demo' });
  await service.whenIdle();

  const job = await service.currentJob();
  const disk = await readFile(statePath, 'utf8');

  await assert.rejects(service.apply(job.id, job.reviewToken), { code: 'recovery_required' });
  await assert.rejects(service.rollback('demo', {
    requestId: job.id,
    expectedRevision: 1,
    expectedPreviousDigest: 'a'.repeat(64),
  }), { code: 'recovery_required' });
  assert.equal(await readFile(statePath, 'utf8'), disk);
  assert.equal((await service.currentJob()).status, 'ready');
});

test('M32: close сливает native owned reads и queued reads до unlock, запрещает новые действия',
  async (t) => {
  const source = controlledSource();
  const fixture = await serviceFixture(t, { sources: new PluginSourceRegistry([source]), seed: seedManaged });
  const twoStarted = barrier();
  let started = 0;

  source.listVersions = async (_url, signal) => {
    const result = await fixture.service.run(process.execPath, ['-e',
      "process.stderr.write('READY\\n'); setInterval(() => {}, 1000);",
    ], {
      cwd: fixture.root,
      timeoutMs: 60_000,
      signal,
      onStderr: (chunk) => {
        if (chunk.includes('READY')) {
          started += 1;

          if (started === 2) {
            twoStarted.release();
          }
        }
      },
    });

    if (result.aborted) {
      throw installError('cancelled');
    }

    return [];
  };

  const reads = [
    fixture.service.listVersions('mirror://fixture/demo'),
    fixture.service.listVersions('mirror://fixture/demo'),
    fixture.service.listVersions('mirror://fixture/demo'),
    fixture.service.checkUpdates(),
  ].map((read) => read.catch((error) => error));

  await twoStarted.promise;

  const before = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  const drainEntered = barrier();
  const drainHeld = barrier();

  assert.equal(Object.keys(before.workers).length, 2);
  assert.equal(started, 2);
  fixture.service.store.options.write = async (file, text) => {
    if (Object.keys(JSON.parse(text).workers).length === 0) {
      drainEntered.release();
      await drainHeld.promise;
    }

    await writeDurableFile(file, text);
  };

  const closing = fixture.service.close();
  const repeated = fixture.service.close();
  const early = await Promise.race([
    drainEntered.promise.then(() => false),
    closing.then(() => true),
  ]);

  try {
    assert.equal(early, false, 'close ждёт durable worker.finished ACK');
    await assert.rejects(fixture.service.listVersions('mirror://fixture/demo'), { code: 'service_closed' });
    await assert.rejects(fixture.service.startInstall({ url: 'bad' }), { code: 'service_closed' });
    await assert.rejects(fixture.service.checkUpdates(), { code: 'service_closed' });

    const contender = new PluginInstallService(fixture.service.options);

    try {
      assert.equal((await contender.recover()).blockedIds, '*');
    } finally {
      await contender.close();
    }
  } finally {
    drainHeld.release();
    await Promise.all([closing, repeated, ...reads]);
  }

  assert.equal(started, 2, 'queued reads не запускают subprocess после close');
  assert.deepEqual(JSON.parse(await readFile(fixture.statePath, 'utf8')).workers, {});

  for (const worker of Object.values(before.workers)) {
    assert.deepEqual(await liveGroupMembers(worker.pgid), []);
  }

  const successor = new PluginInstallService(fixture.service.options);

  try {
    assert.deepEqual((await successor.recover()).blockedIds, []);
  } finally {
    await successor.close();
  }
});

test('M29b: real Git не проходит gated start без durable worker registry', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0');

  const { service, statePath } = await serviceFixture(t, { blockedClose: true });
  const rejectedWorkers = [];

  service.store.options.write = async (file, text) => {
    const state = JSON.parse(text);

    if (Object.keys(state.workers).length > 0) {
      rejectedWorkers.push(...Object.values(state.workers));

      throw Object.assign(new Error('fixture registry write EIO'), { code: 'EIO' });
    }

    await writeDurableFile(file, text);
  };

  await service.startInstall({ url: repo.url });
  await service.whenIdle();

  const job = await service.currentJob();

  assert.equal(rejectedWorkers.length, 1);
  assert.equal(service.health()?.code, 'recovery_required');
  assert.notEqual(job.status, 'ready');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).workers, {});
  assert.equal((await lstat(path.join(service.workDir, 'jobs', job.id))).isDirectory(), true);
  assert.equal(await lstat(path.join(service.workDir, 'jobs', job.id, 'package')).catch(() => null), null);
  assert.deepEqual(await liveGroupMembers(rejectedWorkers[0].pgid), []);
});

test('M35: apply/apply,cancel,start и rollback/rollback,start имеют один lease и один переход', async (t) => {
  for (const combination of [
    'apply/apply', 'apply/cancel', 'apply/start', 'rollback/rollback', 'rollback/start',
  ]) {
    const fixture = await mirrorPair(t);
    const rollback = combination.startsWith('rollback');
    const base = (await fixture.service.store.read()).plugins.demo;
    let ready = null;

    if (!rollback) {
      fixture.mirror.release('1.2.0');
      await fixture.service.startUpdate('demo');
      await fixture.service.whenIdle();
      ready = await fixture.service.currentJob();
      assert.equal(ready.status, 'ready');
    }

    const input = {
      requestId: '00000000-0000-4000-8000-000000000035',
      expectedRevision: base.revision,
      expectedPreviousDigest: base.previous.payloadDigest,
    };
    const entered = barrier();
    const held = barrier();
    let leases = 0;
    let refreshes = 0;

    fixture.service.bindRuntime({
      isLoaded: () => true,
      prepareReplace: async () => {
        leases += 1;
        entered.release();
        await held.promise;

        return { finish: async () => {} };
      },
      refresh: async () => {
        refreshes += 1;
      },
    });

    const first = rollback ? fixture.service.rollback('demo', input)
      : fixture.service.apply(ready.id, ready.reviewToken);

    await entered.promise;

    const before = await readFile(fixture.statePath, 'utf8');
    const action = combination.split('/')[1];
    const second = (action === 'start'
      ? fixture.service.startInstall({ url: 'mirror://fixture/demo' })
      : action === 'cancel' ? fixture.service.cancel(ready.id)
        : action === 'rollback' ? fixture.service.rollback('demo', input)
          : fixture.service.apply(ready.id, ready.reviewToken)).catch((error) => error);
    let failure;

    try {
      await Promise.resolve();
      assert.equal(leases, 1, 'вторая mutation не получила lease');
      failure = await second;
      assert.equal(failure.code, 'install_busy');
      assert.equal(await readFile(fixture.statePath, 'utf8'), before);
    } finally {
      held.release();
      await Promise.allSettled([first, second]);
    }

    assert.equal((await first).status, 'done');
    assert.equal(leases, 1);
    assert.equal(refreshes, 1);
    assert.equal((await fixture.service.store.read()).plugins.demo.version, rollback ? '1.0.0' : '1.2.0');
  }
});

test('M35b: удержанные finish и refresh у apply/rollback держат operation до конца хвоста',
  { timeout: 60_000 }, async (t) => {
  for (const rollback of [false, true]) {
    for (const holdAt of ['finish', 'refresh']) {
      const fixture = await mirrorPair(t);
      const base = (await fixture.service.store.read()).plugins.demo;
      let ready = null;

      if (!rollback) {
        fixture.mirror.release('1.2.0');
        await fixture.service.startUpdate('demo');
        await fixture.service.whenIdle();
        ready = await fixture.service.currentJob();
        assert.equal(ready.status, 'ready');
      }

      const entered = barrier();
      const held = barrier();
      const effects = [];

      fixture.service.bindRuntime({
        isLoaded: () => true,
        prepareReplace: async () => ({
          finish: async (outcome) => {
            assert.equal(fixture.service.restartRequired('demo'), true);
            assert.equal((await fixture.service.store.read()).job.status, 'done');
            effects.push(`finish:${outcome}`);

            if (holdAt === 'finish') {
              entered.release();
              await held.promise;
            }
          },
        }),
        refresh: async () => {
          assert.equal(fixture.service.restartRequired('demo'), true);
          assert.deepEqual(effects, ['finish:installed']);
          effects.push('refresh');

          if (holdAt === 'refresh') {
            entered.release();
            await held.promise;
          }
        },
      });

      const first = rollback ? fixture.service.rollback('demo', {
        requestId: '00000000-0000-4000-8000-000000000035',
        expectedRevision: base.revision,
        expectedPreviousDigest: base.previous.payloadDigest,
      }) : fixture.service.apply(ready.id, ready.reviewToken);
      const settled = first.then(() => false, () => false);

      try {
        assert.equal(await Promise.race([entered.promise.then(() => true), settled]), true,
          `${rollback ? 'rollback' : 'apply'} дошёл до барьера ${holdAt}`);

        const before = (await fixture.service.store.read()).job;

        await assert.rejects(fixture.service.startInstall({ url: 'mirror://fixture/demo' }),
          { code: 'install_busy' });
        assert.deepEqual((await fixture.service.store.read()).job, before);
        assert.equal((await fixture.service.currentJob()).id, before.id);
      } finally {
        held.release();
      }

      const done = await first;

      assert.equal(done.status, 'done');
      assert.deepEqual(done, (await fixture.service.store.read()).job);
      assert.deepEqual(effects, ['finish:installed', 'refresh']);

      const next = await fixture.service.startInstall({ url: 'mirror://fixture/demo' });

      assert.equal(next.status, 'running');
      assert.notEqual(next.id, done.id);
      assert.equal((await fixture.service.store.read()).job.id, next.id);
      await fixture.service.whenIdle();
    }
  }
});

test('M36-flight: checkUpdates single-flight, три источника имеют максимум два внешних calls', async (t) => {
  const source = controlledSource();
  const twoStarted = barrier();
  const held = barrier();
  let active = 0;
  let maximum = 0;
  let calls = 0;

  source.listVersions = async () => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);

    if (calls === 2) {
      twoStarted.release();
    }

    try {
      await held.promise;

      return [{
        version: '1.2.0',
        tag: 'v1.2.0',
        sha: 'c'.repeat(40),
      }];
    } finally {
      active -= 1;
    }
  };

  const fixture = await serviceFixture(t, {
    sources: new PluginSourceRegistry([source]),
    seed: async ({ service }) => {
      await service.store.mutate((state) => {
        for (const id of ['demo', 'other', 'third']) {
          const record = installedRecord();

          record.source = { kind: 'mirror', url: `mirror://fixture/${id}` };
          state.plugins[id] = record;
        }

        state.nextRevision = 2;
      });
    },
  });
  const first = fixture.service.checkUpdates();

  await twoStarted.promise;

  const second = fixture.service.checkUpdates();

  try {
    assert.equal(calls, 2);
  } finally {
    held.release();
  }

  const results = await Promise.all([first, second]);

  assert.equal(calls, 3, 'повтор не создаёт вторую проверку источников');
  assert.equal(maximum, 2);
  assert.deepEqual(results[0], results[1]);
});

test('M36-CAS: ответ старого source/revision после apply B не перетирает record B', async (t) => {
  const fixture = await mirrorPair(t);
  const source = fixture.mirror.source;
  const held = barrier();
  const entered = barrier();
  const original = source.listVersions;

  source.listVersions = async (url, signal) => {
    if (url === 'mirror://fixture/demo') {
      entered.release();
      await held.promise;

      return [{
        version: '9.0.0',
        tag: 'v9.0.0',
        sha: 'f'.repeat(40),
      }];
    }

    return original(url, signal);
  };

  const oldCheck = fixture.service.checkUpdates();

  await entered.promise;

  try {
    await fixture.service.startInstall({ url: 'mirror://fixture/changed-source' });
    await fixture.service.whenIdle();

    const ready = await fixture.service.currentJob();

    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal((await fixture.service.apply(ready.id, ready.reviewToken)).status, 'done');
  } finally {
    held.release();
  }

  const before = (await fixture.service.store.read()).plugins.demo;

  await oldCheck;
  assert.deepEqual((await fixture.service.store.read()).plugins.demo, before);
  assert.equal(before.source.url, 'mirror://fixture/changed-source');
  assert.notEqual(before.latest.version, '9.0.0');
});

test('M42-local: describe для разных ids ограничивает одновременную inspection двумя', async (t) => {
  const fixture = await mirrorPair(t);

  for (const [version, id] of [['1.2.0', 'other'], ['1.3.0', 'third']]) {
    fixture.mirror.release(version, { manifest: { id } });
    await fixture.service.startInstall({ url: `mirror://fixture/${id}` });
    await fixture.service.whenIdle();

    const ready = await fixture.service.currentJob();

    assert.equal(ready.status, 'ready');
    await fixture.service.apply(ready.id, ready.reviewToken);
  }

  const entered = barrier();
  const held = barrier();
  const source = fixture.mirror.source;
  const original = source.inspectInstalled;
  let active = 0;
  let maximum = 0;
  let calls = 0;

  source.inspectInstalled = async (...args) => {
    active += 1;
    calls += 1;
    maximum = Math.max(maximum, active);

    if (calls === 2) {
      entered.release();
    }

    try {
      await held.promise;

      return original(...args);
    } finally {
      active -= 1;
    }
  };

  const reads = ['demo', 'other', 'third'].map((id) => fixture.service.describe(id));

  await entered.promise;
  held.release();

  const result = await Promise.all(reads);

  assert.equal(maximum, 2);
  assert.equal(calls, 4, 'demo current/previous плюс два current');
  assert.equal(result.every((info) => !info.localChanges), true);
});

test('M43: потерянный ответ A reconciles по A.id при активном B; повтор apply A не трогает B', async (t) => {
  const fixture = await mirrorPair(t);
  const a = await fixture.service.currentJob();
  const held = barrier();
  const entered = barrier();
  const source = fixture.mirror.source;
  const original = source.fetch;

  fixture.mirror.release('1.2.0');
  source.fetch = async (request) => {
    await original(request);
    entered.release();
    await held.promise;
  };

  const b = await fixture.service.startUpdate('demo');

  await entered.promise;

  const before = await readFile(fixture.statePath, 'utf8');
  const current = await readFile(path.join(fixture.pluginsDir, 'demo/plugin.json'), 'utf8');

  try {
    assert.equal((await fixture.service.getJob(a.id)).status, 'done');
    assert.equal((await fixture.service.getJob(a.id)).revision, a.revision);
    assert.equal((await fixture.service.currentJob()).id, b.id);
    await assert.doesNotReject(async () => {
      assert.equal((await fixture.service.apply(a.id, a.reviewToken)).id, a.id);
    });
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);
    assert.equal(await readFile(path.join(fixture.pluginsDir, 'demo/plugin.json'), 'utf8'), current);
    assert.equal((await fixture.service.currentJob()).status, 'running');
  } finally {
    held.release();
    await fixture.service.whenIdle();
  }
});

test('M43b: повтор apply и rollback receipt при чужом job не повторяет lease и refresh',
  { timeout: 60_000 }, async (t) => {
    for (const rollback of [false, true]) {
      const fixture = await mirrorPair(t);
      const record = (await fixture.service.store.read()).plugins.demo;
      const input = {
        requestId: '00000000-0000-4000-8000-000000000043',
        expectedRevision: record.revision,
        expectedPreviousDigest: record.previous.payloadDigest,
      };
      const done = rollback ? await fixture.service.rollback('demo', input)
        : await fixture.service.currentJob();
      const entered = barrier();
      const held = barrier();
      const source = fixture.mirror.source;
      const fetch = source.fetch;
      const effects = [];

      source.fetch = async (request) => {
        await fetch(request);
        entered.release();
        await held.promise;
      };
      fixture.service.bindRuntime({
        isLoaded: () => true,
        prepareReplace: async () => {
          effects.push('lease');

          return { finish: async () => {} };
        },
        refresh: async () => {
          effects.push('refresh');
        },
      });
      fixture.mirror.release('1.2.0');

      const next = await fixture.service.startUpdate('demo');

      await entered.promise;

      try {
        const disk = await readFile(fixture.statePath, 'utf8');
        const repeated = rollback ? await fixture.service.rollback('demo', input)
          : await fixture.service.apply(done.id, done.reviewToken);

        assert.deepEqual(repeated, done);
        assert.equal(await readFile(fixture.statePath, 'utf8'), disk);
        assert.equal((await fixture.service.currentJob()).id, next.id);
        assert.deepEqual(effects, []);
      } finally {
        held.release();
        await fixture.service.whenIdle();
      }
    }
  });

test('M45-effects: close на барьере apply/rollback и native read держит owner до durable outcome и drain',
  async (t) => {
    for (const rollback of [false, true]) {
      const fixture = await mirrorPair(t);
      const current = path.join(fixture.pluginsDir, 'demo');
      const base = (await fixture.service.store.read()).plugins.demo;
      let ready = null;

      if (!rollback) {
        fixture.mirror.release('1.2.0');
        await fixture.service.startUpdate('demo');
        await fixture.service.whenIdle();
        ready = await fixture.service.currentJob();
      }

      const native = fixture.service.filesystem();
      const rename = native.rename;
      const entered = barrier();
      const held = barrier();
      let renamed = 0;

      native.rename = async (from, to) => {
        await rename(from, to);
        renamed += 1;

        if (renamed === 1) {
          entered.release();
          await held.promise;
        }
      };
      fixture.service.filesystem = () => native;

      const transaction = (rollback ? fixture.service.rollback('demo', {
        requestId: '00000000-0000-4000-8000-000000000045',
        expectedRevision: base.revision,
        expectedPreviousDigest: base.previous.payloadDigest,
      }) : fixture.service.apply(ready.id, ready.reviewToken)).catch((error) => error);

      await entered.promise;

      const readStarted = barrier();
      const source = fixture.mirror.source;
      const originalList = source.listVersions;

      source.listVersions = async (_url, signal) => {
        await fixture.service.run(process.execPath, ['-e',
          "process.stderr.write('READ_HELD\\n'); setInterval(() => {}, 1000);",
        ], {
          signal,
          cwd: fixture.root,
          timeoutMs: 60_000,
          onStderr: (chunk) => {
            if (chunk.includes('READ_HELD')) {
              readStarted.release();
            }
          },
        });

        return originalList();
      };

      const read = fixture.service.listVersions('mirror://fixture/demo').catch((error) => error);

      await readStarted.promise;

      const workers = (await fixture.service.store.read()).workers;
      const closing = fixture.service.close().catch((error) => error);
      const repeated = fixture.service.close().catch((error) => error);
      const contender = new PluginInstallService(fixture.service.options);

      try {
        await assert.rejects(fixture.service.startInstall({ url: 'mirror://fixture/demo' }),
          { code: 'service_closed' });
        await assert.rejects(fixture.service.getJob(ready?.id ?? base.sha), { code: 'service_closed' });
        assert.equal((await contender.recover()).blockedIds, '*', 'owner не отпущен до конца transaction');
      } finally {
        await contender.close();
        held.release();
      }

      const results = await Promise.all([transaction, read, closing, repeated]);

      assert.equal(results[0].status, 'done');
      assert.equal(results[2], undefined);
      assert.equal(results[3], undefined);
      assert.equal((await fixture.service.store.read()).job.status, 'done');
      assert.equal((await fixture.service.store.read()).apply, null);
      assert.deepEqual((await fixture.service.store.read()).workers, {});

      for (const worker of Object.values(workers)) {
        assert.deepEqual(await liveGroupMembers(worker.pgid), []);
      }

      const stable = await readFile(fixture.statePath, 'utf8');
      const next = new PluginInstallService(fixture.service.options);

      try {
        assert.deepEqual((await next.recover()).blockedIds, []);
        assert.equal((await next.currentJob()).status, 'done');
        assert.equal(JSON.parse(await readFile(path.join(current, 'plugin.json'), 'utf8')).version,
          rollback ? '1.0.0' : '1.2.0');
        await fixture.service.close();
        assert.equal(await readFile(fixture.statePath, 'utf8'), stable,
          'поздний close не пишет после unlock');
      } finally {
        await next.close();
      }
    }
  });

test('M45-uncertain: ошибка state write не отпускает owner даже без живых writers', async (t) => {
  for (const finishedWorker of [false, true]) {
    const source = controlledSource();
    const fixture = await serviceFixture(t, {
      sources: new PluginSourceRegistry([source]),
      blockedClose: true,
    });
    const originalWrite = fixture.service.store.options.write ?? writeDurableFile;
    let retained = [];

    if (finishedWorker) {
      source.listVersions = async (_url, signal) => {
        await fixture.service.run(process.execPath, ['-e', "process.stdout.write('fixture');"], {
          signal,
          cwd: fixture.root,
          timeoutMs: 10_000,
        });

        return [];
      };
      fixture.service.store.options.write = async (file, text) => {
        const next = JSON.parse(text);

        if (retained.length > 0 && Object.keys(next.workers).length === 0) {
          throw Object.assign(new Error('fixture finished registry EIO'), { code: 'EIO' });
        }

        retained = Object.values(next.workers);
        await originalWrite(file, text);
      };
      await fixture.service.listVersions('mirror://fixture/demo');
      assert.equal(retained.length, 1);

      for (const worker of retained) {
        assert.deepEqual(await liveGroupMembers(worker.pgid), []);
      }
    } else {
      fixture.service.store.options.write = async () => {
        throw Object.assign(new Error('fixture initial write EIO'), { code: 'EIO' });
      };
      await assert.rejects(fixture.service.startInstall({ url: 'mirror://fixture/demo' }));
      assert.equal(source.calls.length, 0);
    }

    fixture.service.store.options.write = originalWrite;
    await assert.rejects(fixture.service.close(), { code: 'recovery_required' });
    await assert.rejects(fixture.service.close(), { code: 'recovery_required' });

    const next = new PluginInstallService(fixture.service.options);

    try {
      assert.equal((await next.recover()).blockedIds, '*', 'неустойчивый исход держит owner lock');
    } finally {
      await next.close();
    }
  }
});

test('M45-start: close ждёт durable running до появления preparation promise', async (t) => {
  const source = controlledSource();
  const fixture = await serviceFixture(t, { sources: new PluginSourceRegistry([source]) });
  const nativeWrite = fixture.service.store.options.write ?? writeDurableFile;
  const entered = barrier();
  const held = barrier();
  let waiting = true;

  fixture.service.store.options.write = async (file, text) => {
    if (waiting && JSON.parse(text).job?.status === 'running') {
      waiting = false;
      entered.release();
      await held.promise;
    }

    await nativeWrite(file, text);
  };

  const start = fixture.service.startInstall({ url: 'mirror://fixture/demo' }).catch((error) => error);

  await entered.promise;

  const closing = fixture.service.close().catch((error) => error);
  const contender = new PluginInstallService(fixture.service.options);

  try {
    assert.equal((await contender.recover()).blockedIds, '*');
  } finally {
    held.release();
    await contender.close();
  }

  const [job, closed] = await Promise.all([start, closing]);

  assert.equal(job.status, 'running');
  assert.equal(closed, undefined);
  assert.equal((await fixture.service.store.read()).job.status, 'cancelled');
  assert.deepEqual((await fixture.service.store.read()).workers, {});

  const stable = await readFile(fixture.statePath, 'utf8');
  const next = new PluginInstallService(fixture.service.options);

  try {
    assert.deepEqual((await next.recover()).blockedIds, []);
    assert.equal((await next.currentJob()).status, 'cancelled');
    await fixture.service.whenIdle();
    assert.equal(await readFile(fixture.statePath, 'utf8'), stable);
  } finally {
    await next.close();
  }
});

test('M45-refresh: close удерживает owner пока допущенный scanner refresh не окончен', async (t) => {
  const fixture = await serviceFixture(t);
  const started = barrier();
  const held = barrier();

  await fixture.service.recover();
  fixture.service.bindRuntime({
    isLoaded: () => false,
    prepareReplace: async () => ({ finish: async () => {} }),
    refresh: async () => {
      started.release();
      await held.promise;
    },
  });

  const refresh = fixture.service.refreshCatalog();

  await started.promise;

  const closing = fixture.service.close();

  try {
    const waitsForRefresh = await Promise.race([
      closing.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 100)),
    ]);

    assert.equal(waitsForRefresh, true);
    assert.equal(fixture.service.owner !== null, true);
  } finally {
    held.release();
    await Promise.all([refresh, closing]);
  }
});
