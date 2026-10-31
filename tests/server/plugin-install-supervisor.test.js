import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commandTree } from './helpers/pluginCommandTree.js';

import { runCommand } from '../../server/src/lib/packageInstall/runCommand.ts';

import {
  readProcessIdentity,
  terminateOwnedWorker,
} from '../../server/src/lib/packageInstall/workerIdentity.ts';

import { writeDurableFile } from '../../server/src/lib/durableFile.ts';
import { withPathLock } from '../../server/src/lib/pathLock.ts';

const OWNER = new URL('./fixtures/plugin-command-owner.mjs', import.meta.url);

test('RC6: исключение callback не роняет owner и завершает свою команду', async (t) => {
  const child = fork(OWNER, [], {
    env: { PATH: '/usr/bin:/bin' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let result = null;

  child.on('message', (message) => {
    result = message.result;
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // После штатного завершения своей fixture группа уже отсутствует.
      // Чужие PID и группы в этой проверке не используются.
    }
  });

  const [code] = await once(child, 'exit');

  assert.equal(code, 0);
  assert.notEqual(result?.code, 0);
  assert.equal(result?.stderr.includes('fixture-secret'), false);
});

/**
 * Явный барьер удерживает запись ownership до разрешения родителем.
 * Ожидание не зависит от произвольной задержки планировщика.
 */
function barrier() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test('RC7: durable ACK обязателен до запуска target, отказ записи не исполняет target', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-command-ack-'));
  const marker = path.join(root, 'marker');
  const started = barrier();
  const ack = barrier();
  const finished = [];
  const controller = new AbortController();
  const operation = runCommand(process.execPath, ['-e', `
    require('node:fs').writeFileSync(process.argv[1], 'EXECUTED');
  `, marker], {
    env: {},
    timeoutMs: 5000,
    signal: controller.signal,
    ownership: {
      async started(worker) {
        started.resolve(worker);
        await ack.promise;
      },
      async finished(id) {
        finished.push(id);
      },
    },
  });

  t.after(async () => {
    ack.resolve();
    controller.abort();
    await operation;
    await rm(root, { recursive: true, force: true });
  });

  const first = await Promise.race([
    started.promise.then((worker) => ({ kind: 'started', worker })),
    operation.then(() => ({ kind: 'exit' })),
  ]);

  assert.equal(first.kind, 'started');
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
  assert.ok(first.worker.pid > 0);
  assert.ok(first.worker.supervisorPid !== first.worker.pgid);

  ack.resolve();

  assert.equal((await operation).code, 0);
  assert.equal(await readFile(marker, 'utf8'), 'EXECUTED');
  assert.deepEqual(finished, [first.worker.commandId]);

  const rejectedMarker = path.join(root, 'rejected');
  const rejected = await runCommand(process.execPath, ['-e', `
    require('node:fs').writeFileSync(process.argv[1], 'EXECUTED');
  `, rejectedMarker], {
    env: {},
    timeoutMs: 5000,
    ownership: {
      async started() {
        throw new Error('fixture-write-failed');
      },
      async finished() {
        throw new Error('finished не разрешён после неустойчивого started');
      },
    },
  });

  assert.notEqual(rejected.code, 0);
  assert.equal(await readFile(rejectedMarker, 'utf8').catch(() => null), null);
});

/**
 * Linux identity различает живого writer и уже завершённый zombie.
 * Проверяется только PID потомков, созданных текущей fixture.
 */
async function alive(pid) {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);

  return Boolean(raw && raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0] !== 'Z');
}

test('RC8: отмена завершает внука, игнорирующего SIGTERM и держащего pipe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-command-group-'));
  const marker = path.join(root, 'writer');
  const controller = new AbortController();
  let worker = null;
  let descendants = null;
  let pending = '';
  const script = commandTree(marker);
  const operation = runCommand(process.execPath, ['-e', script, marker], {
    env: {},
    timeoutMs: 10000,
    signal: controller.signal,
    ownership: {
      async started(value) {
        worker = value;
      },
      async finished() {},
    },
    onStderr(chunk) {
      pending += chunk;

      if (pending.includes('\n')) {
        descendants = JSON.parse(pending.trim());
        controller.abort();
      }
    },
  });
  let deadlineTimer;

  t.after(async () => {
    clearTimeout(deadlineTimer);
    controller.abort();

    if (worker && await alive(worker.pid)) {
      process.kill(-worker.pgid, 'SIGKILL');
    } else if (descendants && await alive(descendants[1])) {
      process.kill(-worker.pgid, 'SIGKILL');
    }

    await operation;
    await rm(root, { recursive: true, force: true });
  });

  const result = await Promise.race([
    operation,
    new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve(null), 3500);
    }),
  ]);

  assert.equal(Boolean(result), true, 'группа завершена в ограниченный срок');
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(await alive(descendants[0]), false);
  assert.equal(await alive(descendants[1]), false);
  assert.equal(await alive(worker.pid), false);
});

test('RC9: выход child не оставляет внука с pipe и не зависает навсегда', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-command-group-'));
  const marker = path.join(root, 'writer');
  const controller = new AbortController();
  let worker = null;
  let descendants = null;
  let pending = '';
  const script = commandTree(marker, true);
  const operation = runCommand(process.execPath, ['-e', script, marker], {
    env: {},
    timeoutMs: 10000,
    signal: controller.signal,
    ownership: {
      async started(value) {
        worker = value;
      },
      async finished() {},
    },
    onStderr(chunk) {
      pending += chunk;

      if (pending.includes('\n')) {
        descendants = JSON.parse(pending.trim());
        // Child сам завершится после подтверждения готовности внука.
        // Supervisor обязан убрать оставшуюся группу без abort владельца.
      }
    },
  });
  let deadlineTimer;

  t.after(async () => {
    clearTimeout(deadlineTimer);
    controller.abort();

    if (worker && await alive(worker.pid)) {
      process.kill(-worker.pgid, 'SIGKILL');
    } else if (descendants && await alive(descendants[1])) {
      process.kill(-worker.pgid, 'SIGKILL');
    }

    await operation;
    await rm(root, { recursive: true, force: true });
  });

  const result = await Promise.race([
    operation,
    new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve(null), 3500);
    }),
  ]);

  assert.equal(Boolean(result), true, 'группа завершена в ограниченный срок');
  assert.equal(result.aborted, false);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(await alive(descendants[0]), false);
  assert.equal(await alive(descendants[1]), false);
  assert.equal(await alive(worker.pid), false);
});

/**
 * Ожидает только фактическое завершение созданных тестом процессов после IPC-барьера.
 * Предельный срок превращает оставшегося writer в целевой assert, а не вечное ожидание.
 */
async function waitStopped(pids, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await Promise.all(pids.map(alive))).some(Boolean)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return false;
}

test('RC10: crash владельца после ACK завершает supervisor и всю группу', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-command-owner-crash-'));
  const child = fork(new URL('./fixtures/plugin-command-crash-owner.mjs', import.meta.url), [root], {
    env: { PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let owned = null;

  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }

    if (owned && await alive(owned.worker.supervisorPid)) {
      process.kill(-owned.worker.pgid, 'SIGKILL');
      process.kill(owned.worker.supervisorPid, 'SIGKILL');
    }

    await rm(root, { recursive: true, force: true });
  });

  [owned] = await once(child, 'message');

  assert.equal(owned.type, 'ready');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'workers.json'), 'utf8')), owned.worker);

  const exit = once(child, 'exit');

  child.kill('SIGKILL');
  await exit;

  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(await waitStopped([
    owned.worker.supervisorPid,
    owned.worker.pid,
    ...owned.descendants,
  ]), true, 'до cleanup больше нет живого writer');
});

test('RC11: несовпадающая identity чужого fixture не разрешает сигнал', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-command-foreign-'));
  const marker = path.join(root, 'signalled');
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => require('node:fs').writeFileSync(process.argv[1], 'SIGNAL'));
    process.stdout.write('ready');
    setInterval(() => {}, 100);
  `, marker], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });

  child.stderr.resume();
  t.after(async () => {
    const exit = once(child, 'exit');

    child.kill('SIGKILL');
    await exit;
    await rm(root, { recursive: true, force: true });
  });

  await once(child.stdout, 'data');

  const actual = await readProcessIdentity(child.pid);
  const outcome = await terminateOwnedWorker({
    supervisorPid: child.pid,
    supervisorStartTime: String(BigInt(actual.startTime) + 1n),
    pid: child.pid,
    pgid: actual.pgid,
    startTime: actual.startTime,
  });

  assert.equal(outcome, false, 'неоднозначность блокирует recovery');
  assert.equal(await alive(child.pid), true);
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
});

test('RC13: независимый durable registry workers и evidence при отказе finished', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-command-registry-'));
  const registry = path.join(root, 'workers.json');
  const release = path.join(root, 'release');
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const ready = controllers.map(() => barrier());
  const workers = [];
  let failFinished = false;

  await writeDurableFile(registry, '{}');

  /**
   * Storage adapter сериализует записи всех одновременно работающих команд.
   * Запись fsync проходит до ACK и до завершения finished callback.
   */
  const change = (mutate) => withPathLock(registry, async () => {
    const current = JSON.parse(await readFile(registry, 'utf8'));

    mutate(current);
    await writeDurableFile(registry, JSON.stringify(current));
  });
  const ownership = {
    async started(worker) {
      workers.push(worker);
      await change((current) => {
        current[worker.commandId] = worker;
      });
    },
    async finished(id) {
      if (failFinished) {
        throw new Error('fixture-finished-write-failed');
      }

      await change((current) => {
        delete current[id];
      });
    },
  };
  const operations = ['job', 'listVersions', 'checkUpdates'].map((name, index) =>
    runCommand(process.execPath, ['-e', `
      process.stderr.write(${JSON.stringify(name)});
      setInterval(() => {
        if (${index} === 2 && require('node:fs').existsSync(${JSON.stringify(release)})) {
          process.exit(0);
        }
      }, 20);
    `], {
      env: {},
      timeoutMs: 5000,
      signal: controllers[index].signal,
      ownership,
      onStderr() {
        ready[index].resolve();
      },
    }));

  t.after(async () => {
    controllers.forEach((controller) => controller.abort());
    await Promise.all(operations);
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all(ready.map((entry) => entry.promise));

  const before = JSON.parse(await readFile(registry, 'utf8'));

  assert.equal(Object.keys(before).length, 3);
  assert.equal(new Set(workers.map((worker) => worker.commandId)).size, 3);

  controllers[0].abort();
  await operations[0];

  const after = JSON.parse(await readFile(registry, 'utf8'));

  assert.equal(Object.keys(after).length, 2);

  const living = await Promise.all(Object.values(after).map((worker) => alive(worker.pid)));

  assert.equal(living.every(Boolean), true);

  controllers[1].abort();
  await operations[1];
  failFinished = true;
  await writeFile(release, 'release');

  assert.equal((await operations[2]).code, 1);

  const evidence = JSON.parse(await readFile(registry, 'utf8'));

  assert.equal(Object.keys(evidence).length, 1);
  assert.equal(await alive(Object.values(evidence)[0].pid), false);
});

test('RC14: supervisor ограничивает весь root, свободное место и последний замер', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-command-budget-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const budget = {
    root,
    maxBytes: 1024,
    minFreeBytes: 0,
    checkIntervalMs: 10,
  };
  const excess = await runCommand(process.execPath, ['-e', `
    require('node:fs').writeFileSync(process.argv[1], Buffer.alloc(8192));
    setInterval(() => {}, 100);
  `, path.join(root, 'large')], {
    env: {},
    timeoutMs: 1000,
    workspaceBudget: budget,
  });

  assert.equal(excess.workspaceLimitExceeded, true);
  assert.equal(excess.timedOut, false);

  await rm(path.join(root, 'large'));

  const free = await runCommand(process.execPath, ['-e', "process.stdout.write('executed')"], {
    env: {},
    timeoutMs: 1000,
    workspaceBudget: { ...budget, minFreeBytes: Number.MAX_SAFE_INTEGER },
  });

  assert.equal(free.workspaceLimitExceeded, true);
  assert.equal(free.stdout, '');

  const final = await runCommand(process.execPath, ['-e', `
    require('node:fs').writeFileSync(process.argv[1], Buffer.alloc(8192));
  `, path.join(root, 'last')], {
    env: {},
    timeoutMs: 1000,
    workspaceBudget: { ...budget, checkIntervalMs: 10000 },
  });

  assert.equal(final.workspaceLimitExceeded, true);
  assert.notEqual(final.code, 0);

  await rm(root, { recursive: true, force: true });
});


test('RC8-timeout: deadline завершает внука через независимый SIGKILL', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-command-group-'));
  const marker = path.join(root, 'writer');
  const controller = new AbortController();
  let worker = null;
  let descendants = null;
  let pending = '';
  const script = commandTree(marker);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const operation = runCommand(process.execPath, ['-e', script, marker], {
    env: {},
    timeoutMs: 10000,
    signal: controller.signal,
    ownership: {
      async started(value) {
        worker = value;
      },
      async finished() {},
    },
    onStderr(chunk) {
      pending += chunk;

      if (pending.includes('\n')) {
        descendants = JSON.parse(pending.trim());
        t.mock.timers.tick(10000);
      }
    },
  });

  t.after(async () => {
    t.mock.timers.reset();
    controller.abort();

    if (worker && await alive(worker.pid)) {
      process.kill(-worker.pgid, 'SIGKILL');
    } else if (descendants && await alive(descendants[1])) {
      process.kill(-worker.pgid, 'SIGKILL');
    }

    await operation;
    await rm(root, { recursive: true, force: true });
  });

  const result = await operation;

  assert.equal(result.aborted, false);
  assert.equal(result.timedOut, true);
  assert.equal(await alive(descendants[0]), false);
  assert.equal(await alive(descendants[1]), false);
  assert.equal(await alive(worker.pid), false);
});
