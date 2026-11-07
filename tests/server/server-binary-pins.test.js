import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { packagePayload } from '../../deepseek/scripts/packagePayload.mts';
import { deepSeekPayloadFixture } from '../helpers/deepseekPayload.mts';
import { packageIdFor } from '../../server/src/binary/metadata.ts';
import {
  adoptPreparation,
  addRuntimeLeaseOwner,
  inspectRuntimeLeases,
  materializeWithLease,
  readProcessOwner,
  releaseRuntimeLeaseOwner,
  runtimeOwnerState,
  withPackageLock,
} from '../../server/src/binary/leases.ts';

/**
 * Архив синтетический, а cache и все процессы принадлежат одному тесту.
 * AfterReady даёт барьер внутри настоящего lock распаковщика.
 */
async function leaseFixture(t) {
  const { root, options } = await deepSeekPayloadFixture(t);
  const payload = await packagePayload(options);
  const packageId = packageIdFor({ payload });
  const cacheDir = path.join(root, 'cache');

  return {
    cacheDir,
    packageId,
    payload,
    archive: async function* () {
      yield await fs.readFile(options.outputFile);
    },
  };
}

/**
 * Listener ставится до ready; ожидающие сообщения не теряются при быстром child.
 * Cleanup убивает только созданный здесь процесс и всегда дожидается его close.
 */
function ownProcess(t) {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "process.on('message', () => {}); process.send({kind:'ready'});"], {
    env: { PATH: '', TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const ready = new Promise((resolve) => child.once('message', resolve));

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await closed;
  });

  return {
    child,
    closed,
    ready,
  };
}

test('SB17a prepare-held-during-VPN: lease опубликован до выхода package lock', async (t) => {
  const options = await leaseFixture(t);
  let observed = false;
  const result = await materializeWithLease({
    ...options,
    afterReady: async () => {
      observed = (await inspectRuntimeLeases(options)).state === 'protected';
    },
  }, { kind: 'prepare', ownerPid: process.pid });

  assert.equal(observed, true, 'prepare-held-during-VPN: GC видит lease до spawn');
  assert.deepEqual(result.lease.owners, [await readProcessOwner(process.pid)]);
  assert.equal(result.root, path.join(options.cacheDir, 'packages', options.packageId));
  assert.equal((await fs.stat(path.join(options.cacheDir, 'leases', options.packageId,
    `${result.lease.token}.json`))).mode & 0o777, 0o600);
  await assert.rejects(() => withPackageLock(options.cacheDir, options.packageId,
    () => withPackageLock(options.cacheDir, options.packageId, async () => {}, { waitMs: 5, pollMs: 1 })),
  { code: 'directory_lock_busy' });
});

test('SB17a launcher-died-worker-live: ACK и cleanup не снимают живого worker', async (t) => {
  const options = await leaseFixture(t);
  const launcher = ownProcess(t);
  const worker = ownProcess(t);

  await Promise.all([launcher.ready, worker.ready]);

  const { lease } = await materializeWithLease(options, { kind: 'prepare', ownerPid: process.pid });
  const handle = { ...options, token: lease.token };

  await adoptPreparation({ ...handle, ownerPid: launcher.child.pid });
  await releaseRuntimeLeaseOwner({ ...handle, owner: await readProcessOwner(process.pid) });
  await addRuntimeLeaseOwner({ ...handle, ownerPid: worker.child.pid });
  launcher.child.kill('SIGKILL');
  await launcher.closed;

  assert.equal((await inspectRuntimeLeases(options)).state, 'protected', 'worker удерживает cache');
  await releaseRuntimeLeaseOwner({
    ...handle,
    owner: (await inspectRuntimeLeases(options)).leases[0].owners.find(
      (owner) => owner.pid === launcher.child.pid),
  });
  assert.equal((await inspectRuntimeLeases(options)).state, 'protected');
  worker.child.kill('SIGKILL');
  await worker.closed;

  assert.equal((await inspectRuntimeLeases(options)).state, 'unprotected', 'оба умерли по proc proof');
});

test('SB17a PID reuse, zombie, EACCES и неизвестный stat проверяются через proc', async () => {
  const owner = await readProcessOwner(process.pid);

  assert.equal(await runtimeOwnerState(owner), 'alive', 'собственная kernel identity жива');
  assert.equal(await runtimeOwnerState({ ...owner, starttime: '0' }), 'dead', 'PID reuse');

  const stat = await fs.readFile(`/proc/${owner.pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')') + 2;

  assert.equal(await runtimeOwnerState(owner, {
    readStat: async () => stat.slice(0, end) + 'Z' + stat.slice(end + 1),
  }), 'dead', 'zombie доказан stat, а не kill(0)');
  assert.equal(await runtimeOwnerState(owner, {
    readStat: async () => {
      throw Object.assign(new Error('нет доступа'), { code: 'EACCES' });
    },
  }), 'unknown');
  assert.equal(await runtimeOwnerState(owner, { readStat: async () => 'bad' }), 'unknown');
  assert.equal(await runtimeOwnerState(owner, {
    readStat: async () => {
      throw Object.assign(new Error('нет PID'), { code: 'ENOENT' });
    },
  }), 'dead');
});

test('SB17a чужой owner, malformed и symlink lease сохраняются с именованным отказом', async (t) => {
  const options = await leaseFixture(t);
  const { lease } = await materializeWithLease(options, { kind: 'prepare', ownerPid: process.pid });
  const handle = { ...options, token: lease.token };
  const file = path.join(options.cacheDir, 'leases', options.packageId, `${lease.token}.json`);

  await assert.rejects(() => releaseRuntimeLeaseOwner({
    ...handle,
    owner: { pid: process.pid, starttime: '0' },
  }), { code: 'server_lease_owner_mismatch' });
  assert.equal((await inspectRuntimeLeases(options)).state, 'protected');
  await fs.writeFile(file, '{}');
  assert.equal((await inspectRuntimeLeases(options)).state, 'unknown');
  await assert.rejects(() => adoptPreparation(handle), { code: 'server_lease_invalid' });
  await fs.unlink(file);
  await fs.symlink(path.join(options.cacheDir, 'sentinel'), file);
  assert.equal((await inspectRuntimeLeases(options)).state, 'unknown');
  await assert.rejects(() => adoptPreparation(handle), { code: 'server_lease_invalid' });
});

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import {
  bindFactoryRuntime,
  inspectFactoryRuntimePins,
  reserveFactoryRuntime,
} from '../../server/src/lib/factoryRuntimePins.ts';

/**
 * Immutable attempt повторяет identity и checksum настоящего движка.
 * Каталоги control, profiles и provider state раздельны и физические.
 */
async function pinFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-pins-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const packageId = 'a'.repeat(64);
  const cacheDir = path.join(root, 'cache');
  const runtimeRoot = path.join(cacheDir, 'packages', packageId);
  const controlRoot = path.join(root, 'control');
  const stateRoot = path.join(root, 'state');
  const profileRoot = path.join(root, 'profiles');
  const engineHome = path.join(runtimeRoot, 'engine');
  const engineBin = path.join(engineHome, 'bin/factory');
  const node = path.join(runtimeRoot, 'runtime/node/bin/node');
  const attempt = `a_${'1'.repeat(32)}`;
  const task = '42';
  const attemptDir = path.join(controlRoot, 'protocol-v2/tasks', `t${task}`, 'attempts', attempt);

  for (const dir of [cacheDir, engineHome, path.dirname(engineBin), path.dirname(node), controlRoot,
    stateRoot, profileRoot, attemptDir]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  await fs.writeFile(engineBin, '#!/bin/bash\nexit 0\n', { mode: 0o555 });
  await fs.writeFile(node, 'synthetic-node', { mode: 0o555 });

  await fs.writeFile(path.join(controlRoot, 'protocol-v2/tasks/t42/protocol.json'),
    JSON.stringify({ schema: 1, protocolVersion: 2 }), { mode: 0o400 });

  const metadata = JSON.stringify({
    schema: 2,
    protocolVersion: 2,
    taskId: task,
    attemptId: attempt,
    profile: 'demo-profile',
    createdAt: '2026-01-01T00:00:00Z',
    routesDir: profileRoot,
    catalogHash: 'c'.repeat(64),
    origin: 'fresh',
    previousAttemptId: null,
    recoveryReason: null,
    queueDispatchId: null,
    runnerPrimaryOverride: '',
  });

  await fs.writeFile(path.join(attemptDir, 'attempt.json'), metadata, { mode: 0o400 });
  await fs.writeFile(path.join(attemptDir, 'attempt.sha256'),
    createHash('sha256').update(metadata).digest('hex') + '\n', { mode: 0o400 });

  return {
    cacheDir,
    controlRoot,
    stateRoot,
    profileRoot,
    packageId,
    runtimeRoot,
    engineHome,
    engineBin,
    node,
    attempt,
    task,
    attemptDir,
  };
}

test('SB17b durable reservation без PID удерживает runtime до назначения attempt ID', async (t) => {
  const input = await pinFixture(t);
  const result = await reserveFactoryRuntime(input);

  assert.equal((await inspectFactoryRuntimePins(input)).state, 'protected', 'reservation удерживает A');
  assert.match(result.token, /^[a-f0-9-]{36}$/u);
  assert.equal(result.scope, createHash('sha256').update(canonicalJson({
    controlRoot: input.controlRoot,
    stateRoot: input.stateRoot,
    profileRoot: input.profileRoot,
  })).digest('hex'));
  assert.equal((await fs.stat(result.reservation)).mode & 0o777, 0o600);
});

test('SB17b attempt-at-gate-without-PID: authority важнее отсутствующего GC index', async (t) => {
  const input = await pinFixture(t);
  const reservation = await reserveFactoryRuntime(input);
  const before = await fs.readFile(path.join(input.attemptDir, 'attempt.json'), 'utf8');
  const pin = await bindFactoryRuntime({ ...input, reservation: reservation.reservation });

  assert.equal(pin?.attempt, input.attempt, 'authority привязана к engine ID');
  assert.equal(pin.task, input.task);
  await fs.rm(path.join(input.cacheDir, 'attempt-pins'), { recursive: true, force: true });
  assert.equal((await inspectFactoryRuntimePins(input)).state, 'protected',
    'нет GC index — читается authority');
  assert.equal(await fs.readFile(path.join(input.attemptDir, 'attempt.json'), 'utf8'), before);
  assert.deepEqual(await bindFactoryRuntime({ ...input, reservation: reservation.reservation }), pin);

  const other = await reserveFactoryRuntime(input);

  await assert.rejects(() => bindFactoryRuntime({ ...input, reservation: other.reservation }),
    { code: 'factory_runtime_pin_conflict' });
  assert.equal(await fs.readFile(path.join(input.attemptDir, 'attempt.json'), 'utf8'), before);
});

test('SB17b terminal и abandoned освобождают только проверенную authority', async (t) => {
  const input = await pinFixture(t);
  const reserved = await reserveFactoryRuntime(input);

  await bindFactoryRuntime({ ...input, reservation: reserved.reservation });

  const terminal = JSON.stringify({
    schema: 1,
    protocolVersion: 2,
    taskId: input.task,
    attemptId: input.attempt,
    state: 'abandoned',
    closedAt: '2026-01-02T00:00:00Z',
    reason: 'синтетическая попытка завершена',
  });
  const hash = createHash('sha256').update(terminal).digest('hex');
  const file = path.join(input.attemptDir, `terminal.${hash}.json`);

  await fs.writeFile(file, terminal, { mode: 0o400 });
  assert.equal((await inspectFactoryRuntimePins(input)).state, 'unprotected');
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, '{}');
  await fs.chmod(file, 0o400);
  assert.equal((await inspectFactoryRuntimePins(input)).state, 'unknown', 'повреждение не terminal proof');
});

test('SB17b old-control-root-unreadable и потерянный registry не разрешают delete', async (t) => {
  const input = await pinFixture(t);

  assert.equal((await inspectFactoryRuntimePins(input)).state, 'unknown', 'missing registry не пустой');

  const result = await reserveFactoryRuntime(input);

  await fs.rename(input.controlRoot, `${input.controlRoot}.old`);
  assert.equal((await inspectFactoryRuntimePins(input)).state, 'unknown');
  assert.notEqual(result.reservation, '');
});

/**
 * Отдельный child сообщает durable фазу и ждёт IPC, удерживая свои locks.
 * SIGKILL на барьере проверяет crash recovery без гонок таймера и чужих процессов.
 */
async function crashAt(t, input, operation, phase) {
  const module = new URL('../../server/src/lib/factoryRuntimePins.ts', import.meta.url).href;
  const source = `
    import { reserveFactoryRuntime, bindFactoryRuntime } from ${JSON.stringify(module)};
    process.once('message', async (input) => {
      const checkpoint = async (phase) => {
        process.send({phase});
        await new Promise((resolve) => process.once('message', resolve));
      };
      const operation = input.operation === 'reserve' ? reserveFactoryRuntime : bindFactoryRuntime;
      try {
        await operation({...input.value, checkpoint});
        process.send({done:true});
      } catch (error) {
        process.send({error:String(error)});
      }
    });
    process.send({ready:true});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { PATH: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await closed;
  });

  await new Promise((resolve) => child.once('message', resolve));

  const reached = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Не достигнут барьер ${phase}`)), 10000);

    child.on('message', (message) => {
      if (message.phase === phase) {
        clearTimeout(deadline);
        resolve();
      } else if (message.error || message.done) {
        clearTimeout(deadline);
        reject(new Error(JSON.stringify(message)));
      } else {
        child.send('continue');
      }
    });
  });

  child.send({ operation, value: input });
  await reached;
  child.kill('SIGKILL');
  await closed;
}

for (const phase of ['registry', 'reservation', 'authority', 'index']) {
  test(`SB17c SIGKILL после ${phase} сохраняет A и immutable attempt`, async (t) => {
    const input = await pinFixture(t);
    const before = await fs.readFile(path.join(input.attemptDir, 'attempt.json'), 'utf8');
    let reservation;

    if (['authority', 'index'].includes(phase)) {
      reservation = await reserveFactoryRuntime(input);
      await crashAt(t, { ...input, reservation: reservation.reservation }, 'bind', phase);
    } else {
      await crashAt(t, input, 'reserve', phase);
    }

    assert.notEqual((await inspectFactoryRuntimePins(input)).state, 'unprotected', 'GC сохраняет A');

    if (reservation) {
      const pin = await bindFactoryRuntime({ ...input, reservation: reservation.reservation });

      assert.equal(pin.reservationToken, reservation.token, 'повтор завершает прежний bind');
    }

    assert.equal(await fs.readFile(path.join(input.attemptDir, 'attempt.json'), 'utf8'), before);
  });
}

test('SB17c scope из именованных roots и подмена task/root не перезаписывают authority', async (t) => {
  const input = await pinFixture(t);
  const reserved = await reserveFactoryRuntime(input);
  const otherControl = path.join(path.dirname(input.controlRoot), 'control-other');

  await fs.mkdir(otherControl, { mode: 0o700 });

  const other = await reserveFactoryRuntime({ ...input, controlRoot: otherControl });

  assert.notEqual(other.scope, reserved.scope, 'одинаковая задача в другом root не сталкивается');
  await assert.rejects(() => bindFactoryRuntime({
    ...input,
    task: '43',
    reservation: reserved.reservation,
  }),
    { code: 'factory_runtime_pin_conflict' });
  await assert.rejects(() => bindFactoryRuntime({
    ...input,
    attemptDir: path.dirname(input.attemptDir),
    reservation: reserved.reservation,
  }), { code: 'factory_runtime_attempt_invalid' });

  const [a, b] = await Promise.all([
    bindFactoryRuntime({ ...input, reservation: reserved.reservation }),
    bindFactoryRuntime({ ...input, reservation: reserved.reservation }),
  ]);

  assert.deepEqual(a, b, 'конкурентный повтор bind идемпотентен');
});

test('SB17 foreign GC index не заменяется при bind и оставляет reservation защитой', async (t) => {
  const input = await pinFixture(t);
  const reserved = await reserveFactoryRuntime(input);
  const index = path.join(input.cacheDir, 'attempt-pins', reserved.scope, `${input.attempt}.json`);
  const sentinel = path.join(input.cacheDir, 'sentinel');

  await fs.mkdir(path.dirname(index), { recursive: true, mode: 0o700 });
  await fs.writeFile(sentinel, 'не менять');
  await fs.symlink(sentinel, index);

  await assert.rejects(() => bindFactoryRuntime({ ...input, reservation: reserved.reservation }),
    { code: 'server_runtime_metadata_invalid' });
  assert.equal((await fs.lstat(index)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'не менять');
  assert.equal(await fs.access(reserved.reservation).then(() => true, () => false), true);
});

test('SB17 повтор release после ACK и последнего owner; чужой token отказ', async (t) => {
  const input = await leaseFixture(t);
  const launcher = ownProcess(t);

  await launcher.ready;

  const { lease } = await materializeWithLease(input, { kind: 'prepare', ownerPid: process.pid });
  const location = { ...input, token: lease.token };
  const coordinator = await readProcessOwner(process.pid);

  await adoptPreparation({ ...location, ownerPid: launcher.child.pid });
  await releaseRuntimeLeaseOwner({ ...location, owner: coordinator });
  await assert.doesNotReject(() => releaseRuntimeLeaseOwner({ ...location, owner: coordinator }),
    'повтор prepare release после ACK идемпотентен');

  const server = await readProcessOwner(launcher.child.pid);

  launcher.child.kill('SIGKILL');
  await launcher.closed;
  await releaseRuntimeLeaseOwner({ ...location, owner: server });
  await assert.doesNotReject(() => releaseRuntimeLeaseOwner({ ...location, owner: coordinator }));
  await assert.rejects(() => releaseRuntimeLeaseOwner({
    ...location,
    token: '00000000-0000-4000-8000-000000000001',
    owner: coordinator,
  }), { code: 'server_lease_owner_mismatch' });
});

test('SB17 control и provider state не пересекаются до публикации reservation', async (t) => {
  const input = await pinFixture(t);

  await assert.rejects(() => reserveFactoryRuntime({ ...input, stateRoot: input.controlRoot }),
    { code: 'factory_runtime_pin_invalid' });
  assert.equal(await fs.access(path.join(input.controlRoot, 'server-runtimes'))
    .then(() => true, () => false), false);
});
