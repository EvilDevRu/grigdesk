import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  pruneServerCache, recordServerRuntimeUsage, SERVER_CACHE_POLICY,
} from '../../server/src/binary/prune.ts';
import { createRuntimeLeaseLocked, withPackageLock } from '../../server/src/binary/leases.ts';
import { reserveFactoryRuntime, bindFactoryRuntime } from '../../server/src/lib/factoryRuntimePins.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 2_000_000_000_000;
const IDS = Object.fromEntries(['A', 'B', 'C', 'D', 'E']
  .map((name) => [name, name.toLowerCase().repeat(64)]));

/**
 * Часы фиксированы; current B и previous A старые по возрасту, но всегда сохраняются.
 * C/D не использовались восемь суток, E использовался недавно без активации.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-prune-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const cacheDir = path.join(root, 'cache');

  for (const id of Object.values(IDS)) {
    const dir = path.join(cacheDir, 'packages', id);

    await fs.mkdir(path.join(dir, 'engine/bin'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(dir, 'runtime/node/bin'), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, '.ready.json'), JSON.stringify({ format: 2, packageId: id }),
      { mode: 0o600 });
    await fs.writeFile(path.join(dir, 'engine/bin/factory'), 'synthetic-engine', { mode: 0o555 });
    await fs.writeFile(path.join(dir, 'runtime/node/bin/node'), 'synthetic-node', { mode: 0o555 });
  }

  for (const name of ['C', 'D', 'A', 'B']) {
    await recordServerRuntimeUsage({
      cacheDir,
      packageId: IDS[name],
      now: name === 'B' ? NOW : NOW - 8 * DAY,
    });
  }

  await recordServerRuntimeUsage({
    cacheDir,
    packageId: IDS.E,
    now: NOW - DAY,
    activate: false,
  });

  for (const name of ['cache/releases/backup/grigdesk-server', 'profiles/sentinel', 'chats/sentinel']) {
    const file = path.join(root, name);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'не менять');
  }

  return {
    root,
    cacheDir,
    now: NOW,
  };
}

function retained(result, id) {
  return result.retained.find((entry) => entry.packageId === id)?.reason;
}

test('SB27 manual: удаляются только старые C/D, current B previous A и свежий E сохраняются', async (t) => {
  const input = await fixture(t);
  const result = await pruneServerCache(input);

  assert.deepEqual([...result.deleted].sort(), [IDS.C, IDS.D].sort(), 'unused старше 7 суток удалены');
  assert.equal(retained(result, IDS.A), 'previous');
  assert.equal(retained(result, IDS.B), 'current');
  assert.equal(retained(result, IDS.E), 'recent');
  assert.equal(SERVER_CACHE_POLICY.mode, 'manual');

  for (const name of ['cache/releases/backup/grigdesk-server', 'profiles/sentinel', 'chats/sentinel']) {
    assert.equal(await fs.readFile(path.join(input.root, name), 'utf8'), 'не менять');
  }
});

test('SB27 живой lease и неизвестный owner защищают C/D без TTL', async (t) => {
  const input = await fixture(t);

  await withPackageLock(input.cacheDir, IDS.C, () => createRuntimeLeaseLocked({
    cacheDir: input.cacheDir,
    packageId: IDS.C,
    kind: 'prepare',
    ownerPid: process.pid,
  }));
  await fs.mkdir(path.join(input.cacheDir, 'leases', IDS.D), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(input.cacheDir, 'leases', IDS.D, `${randomUUID()}.json`), '{}',
    { mode: 0o600 });

  const result = await pruneServerCache(input);

  assert.equal(retained(result, IDS.C), 'lease');
  assert.ok(result.unknown.some((entry) => entry.packageId === IDS.D));
  assert.deepEqual(result.deleted, []);
});

test('SB27 missing registry и unknown usage не считаются пустым authority', async (t) => {
  const input = await fixture(t);

  await fs.unlink(path.join(input.cacheDir, 'state/control-roots.json'));

  const missing = await pruneServerCache(input);

  assert.deepEqual(missing.deleted, []);
  assert.ok(missing.unknown.some((entry) => entry.packageId === IDS.C));
  await fs.writeFile(path.join(input.cacheDir, 'state/usage.json'), '{}');

  const badUsage = await pruneServerCache(input);

  assert.deepEqual(badUsage.deleted, []);
});

test('SB27 foreign symlink и ownerless metadata не удаляются, внешний sentinel цел', async (t) => {
  const input = await fixture(t);
  const target = path.join(input.root, 'foreign');

  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'sentinel'), 'жив');
  await fs.rm(path.join(input.cacheDir, 'packages', IDS.C), { recursive: true });
  await fs.symlink(target, path.join(input.cacheDir, 'packages', IDS.C));
  await fs.chmod(path.join(input.cacheDir, 'packages', IDS.D, '.ready.json'), 0o644);

  const result = await pruneServerCache(input);

  assert.deepEqual(result.deleted, []);
  assert.equal(result.unknown.length, 2);
  assert.equal(await fs.readFile(path.join(target, 'sentinel'), 'utf8'), 'жив');
  assert.equal((await fs.lstat(path.join(input.cacheDir, 'packages', IDS.C))).isSymbolicLink(), true);
});

for (const operation of ['rename', 'remove']) {
  test(`SB27 ${operation} ENOSPC/EACCES сохраняет целое опубликованное поколение`, async (t) => {
    const input = await fixture(t);
    const result = await pruneServerCache({
      ...input,
      operations: {
        [operation]: async () => {
          throw Object.assign(new Error('синтетический отказ'), {
            code: operation === 'rename' ? 'ENOSPC' : 'EACCES',
          });
        },
      },
    });

    assert.deepEqual(result.deleted, []);
    assert.ok(result.unknown.some((entry) => entry.packageId === IDS.C));
    assert.equal(await fs.readFile(path.join(input.cacheDir, 'packages', IDS.C, 'engine/bin/factory'),
      'utf8'), 'synthetic-engine');
  });
}

/**
 * Authority paused attempt публикуется тем же reserve/bind протоколом, что в engine.
 * Runtime старый по usage, живых PID нет, а derived index можно удалить независимо.
 */
async function pausedPin(input, bind = true) {
  const controlRoot = path.join(input.root, 'control');
  const stateRoot = path.join(input.root, 'provider-state');
  const profileRoot = path.join(input.root, 'profiles-root');
  const packageId = IDS.C;
  const runtimeRoot = path.join(input.cacheDir, 'packages', packageId);
  const engineHome = path.join(runtimeRoot, 'engine');
  const engineBin = path.join(engineHome, 'bin/factory');
  const node = path.join(runtimeRoot, 'runtime/node/bin/node');
  const task = '42';
  const attempt = `a_${'3'.repeat(32)}`;
  const attemptDir = path.join(controlRoot, 'protocol-v2/tasks/t42/attempts', attempt);

  for (const directory of [controlRoot, stateRoot, profileRoot, attemptDir]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const context = {
    cacheDir: input.cacheDir,
    packageId,
    runtimeRoot,
    engineHome,
    engineBin,
    node,
    controlRoot,
    stateRoot,
    profileRoot,
    task,
  };
  const reservation = await reserveFactoryRuntime(context);

  if (bind) {
    const metadata = JSON.stringify({
      schema: 2,
      protocolVersion: 2,
      taskId: task,
      attemptId: attempt,
      profile: 'sample',
      routesDir: profileRoot,
      catalogHash: 'f'.repeat(64),
    });

    await fs.writeFile(path.join(controlRoot, 'protocol-v2/tasks/t42/protocol.json'),
      JSON.stringify({ schema: 1, protocolVersion: 2 }), { mode: 0o400 });
    await fs.writeFile(path.join(attemptDir, 'attempt.json'), metadata, { mode: 0o400 });
    await fs.writeFile(path.join(attemptDir, 'attempt.sha256'),
      createHash('sha256').update(metadata).digest('hex') + '\n', { mode: 0o400 });
    await bindFactoryRuntime({
      reservation: reservation.reservation,
      task,
      attempt,
      attemptDir,
    });
  }

  return {
    ...context,
    attempt,
    attemptDir,
    reservation: reservation.reservation,
  };
}

test('SB27 paused attempt без PID и GC index удерживает C по authority', async (t) => {
  const input = await fixture(t);

  await pausedPin(input);
  await fs.rm(path.join(input.cacheDir, 'attempt-pins'), { recursive: true });

  const result = await pruneServerCache(input);

  assert.equal(retained(result, IDS.C), 'attempt-pin');
  assert.deepEqual(result.deleted, [IDS.D]);
});

test('SB27 reservation без attempt ID и умершего координатора удерживает C', async (t) => {
  const input = await fixture(t);

  await pausedPin(input, false);

  const result = await pruneServerCache(input);

  assert.equal(retained(result, IDS.C), 'reservation');
  assert.deepEqual(result.deleted, [IDS.D]);
});

test('SB27 old control root unavailable сохраняет связанное поколение C', async (t) => {
  const input = await fixture(t);
  const pin = await pausedPin(input);

  await fs.rename(pin.controlRoot, `${pin.controlRoot}.old`);

  const result = await pruneServerCache(input);

  assert.ok(result.unknown.some((entry) => entry.packageId === IDS.C));
  assert.deepEqual(result.deleted, [IDS.D]);
});

test('SB27 только canonical terminal освобождает paused attempt для GC', async (t) => {
  const input = await fixture(t);
  const pin = await pausedPin(input);
  const terminal = JSON.stringify({
    schema: 1,
    protocolVersion: 2,
    taskId: pin.task,
    attemptId: pin.attempt,
    state: 'finished',
    closedAt: '2026-01-02T00:00:00Z',
    reason: null,
  });
  const hash = createHash('sha256').update(terminal).digest('hex');

  await fs.writeFile(path.join(pin.attemptDir, `terminal.${hash}.json`), terminal, { mode: 0o400 });

  const result = await pruneServerCache(input);

  assert.deepEqual(result.deleted.sort(), [IDS.C, IDS.D].sort());
  assert.equal(await fs.readFile(path.join(pin.attemptDir, `terminal.${hash}.json`), 'utf8'), terminal);
});

test('SB27 ровно 7 суток и полностью опубликованное поколение со staging именем сохраняются', async (t) => {
  const input = await fixture(t);

  await recordServerRuntimeUsage({
    cacheDir: input.cacheDir,
    packageId: IDS.C,
    now: NOW - 7 * DAY,
    activate: false,
  });

  const stagingName = `.${IDS.C}.staging-old`;
  const staging = path.join(input.cacheDir, 'packages', stagingName);

  await fs.mkdir(staging, { mode: 0o700 });
  await fs.writeFile(path.join(staging, '.ready.json'), 'готово');

  const result = await pruneServerCache(input);

  assert.equal(retained(result, IDS.C), 'recent');
  assert.ok(result.unknown.some((entry) => entry.packageId === stagingName));
  assert.equal(await fs.readFile(path.join(staging, '.ready.json'), 'utf8'), 'готово');
});

test('SB27 два GC и launch сериализуются IPC барьерами до rename и нового lease', async (t) => {
  const input = await fixture(t);
  const first = await gcProcess(t, input, 'first');

  await first.message(`renamed:${IDS.C}`);

  const launcher = await gcProcess(t, input, 'launch');
  const second = await gcProcess(t, input, 'second');

  launcher.child.send({ kind: 'ping' });
  second.child.send({ kind: 'ping' });
  await Promise.all([launcher.message('pong'), second.message('pong')]);
  assert.ok(!launcher.messages.some((message) => message.kind === 'done'), 'launch ждёт package lock');
  assert.ok(!second.messages.some((message) => message.kind === 'done'), 'GC2 ждёт global lock');
  first.child.send({ continue: `renamed:${IDS.C}` });
  await first.message(`candidate:${IDS.D}`);

  const launched = await launcher.message('done');

  assert.equal(launched.recreated, true, 'после rename launch заново материализует C');
  first.child.send({ continue: `candidate:${IDS.D}` });

  const a = await first.message('done');
  const b = await second.message('done');

  assert.deepEqual(a.result.deleted.sort(), [IDS.C, IDS.D].sort());
  assert.equal(retained(b.result, IDS.C), 'lease', 'GC2 перечитал lease нового запуска');
  assert.equal(await fs.readFile(path.join(input.cacheDir, 'packages', IDS.C, 'engine'), 'utf8'),
    'recreated');
});

/**
 * Каждый участник гонки — собственный child с queued IPC и явным barrier ACK.
 * Pong доказывает вход в ожидающий lock без случайной задержки setTimeout.
 */
async function gcProcess(t, input, role) {
  const { spawn } = await import('node:child_process');
  const pruneUrl = new URL('../../server/src/binary/prune.ts', import.meta.url).href;
  const leasesUrl = new URL('../../server/src/binary/leases.ts', import.meta.url).href;
  const source = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {pruneServerCache} from ${JSON.stringify(pruneUrl)};
    import {withPackageLock,createRuntimeLeaseLocked} from ${JSON.stringify(leasesUrl)};
    process.on('message', async (message) => {
      if (message.kind === 'ping') { process.send({kind:'pong'}); return; }
      if (message.kind !== 'start') return;
      const {input,role,idC,idD} = message;
      process.send({kind:'started'});
      try {
        if (role === 'launch') {
          const recreated = await withPackageLock(input.cacheDir,idC,async () => {
            const dir = path.join(input.cacheDir,'packages',idC);
            const exists = await fs.lstat(dir).then(()=>true,()=>false);
            if (!exists) {
              await fs.mkdir(dir,{mode:0o700});
              await fs.writeFile(path.join(dir,'.ready.json'),JSON.stringify({format:2,packageId:idC}),
                {mode:0o600});
              await fs.writeFile(path.join(dir,'engine'),'recreated',{mode:0o444});
            }
            await createRuntimeLeaseLocked({cacheDir:input.cacheDir,packageId:idC,kind:'server'});
            return !exists;
          });
          process.send({kind:'done',recreated});
        } else {
          const result = await pruneServerCache({...input,checkpoint:async(phase,id)=>{
            const key=phase+':'+id;
            if (role==='first' && ((phase==='renamed' && id===idC) || (phase==='candidate' && id===idD))) {
              process.send({kind:key});
              await new Promise(resolve=>{
                const accept=message=>{
                  if(message.continue===key) {process.off('message',accept);resolve();}
                };
                process.on('message',accept);
              });
            }
          }});
          process.send({kind:'done',result});
        }
      } catch(error) {process.send({kind:'failed',error:String(error)});}
    });
    process.send({kind:'ready'});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { PATH: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages = [];
  const waiters = new Set();
  const closed = new Promise((resolve) => child.once('close', resolve));

  child.on('message', (value) => {
    messages.push(value);

    for (const wake of waiters) {
      wake();
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await closed;
  });

  const message = (kind) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`Нет IPC ${kind}: ${JSON.stringify(messages)}`));
    }, 10000);
    /**
     * Очередь удерживает ранний IPC до установки ожидающего callback.
     * Ошибка child завершает ожидание вместо зависания на следующем барьере.
     */
    const check = () => {
      const value = messages.find((entry) => entry.kind === kind || entry.kind === 'failed');

      if (value) {
        clearTimeout(deadline);
        waiters.delete(check);
        value.kind === 'failed' ? reject(new Error(value.error)) : resolve(value);
      }
    };

    waiters.add(check);
    check();
  });

  await message('ready');
  child.send({
    kind: 'start',
    input,
    role,
    idC: IDS.C,
    idD: IDS.D,
  });
  await message('started');

  return {
    child,
    messages,
    message,
  };
}

test('SB27 ownerless derived index означает unknown authority, а не пустой список pins', async (t) => {
  const input = await fixture(t);
  const directory = path.join(input.cacheDir, 'attempt-pins', 'f'.repeat(64));

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, `a_${'4'.repeat(32)}.json`), '{}', { mode: 0o600 });

  const result = await pruneServerCache(input);

  assert.deepEqual(result.deleted, [], 'неизвестный индекс не разрешает удаление C/D');
  assert.ok(result.unknown.some((entry) => entry.packageId === IDS.C));
});

test('SB27 EACCES proc не доказывает смерть owner и удерживает C', async (t) => {
  const input = await fixture(t);
  const pid = 123456789;
  const directory = path.join(input.cacheDir, 'leases', IDS.C);
  const token = randomUUID();

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, `${token}.json`), JSON.stringify({
    format: 1,
    kind: 'engine',
    token,
    packageId: IDS.C,
    owners: [{ pid, starttime: '1' }],
  }), { mode: 0o600 });

  const read = fs.readFile.bind(fs);

  t.mock.method(fs, 'readFile', (file, ...args) => {
    if (file === `/proc/${pid}/stat`) {
      throw Object.assign(new Error('нет доступа к proc'), { code: 'EACCES' });
    }

    return read(file, ...args);
  });

  const result = await pruneServerCache(input);

  assert.ok(result.unknown.some((entry) => entry.packageId === IDS.C));
  assert.deepEqual(result.deleted, [IDS.D]);
});

test('SB27 terminal с верным hash и неканоническим временем остаётся unknown', async (t) => {
  const input = await fixture(t);
  const pin = await pausedPin(input);
  const terminal = JSON.stringify({
    schema: 1,
    protocolVersion: 2,
    taskId: pin.task,
    attemptId: pin.attempt,
    state: 'finished',
    closedAt: '2026-01-02',
    reason: null,
  });
  const hash = createHash('sha256').update(terminal).digest('hex');

  await fs.writeFile(path.join(pin.attemptDir, `terminal.${hash}.json`), terminal, { mode: 0o400 });

  const result = await pruneServerCache(input);

  assert.ok(!result.deleted.includes(IDS.C), 'hash не заменяет closed terminal schema движка');
  assert.ok(result.unknown.some((entry) => entry.packageId === IDS.C));
});

test('SB27 dangling link вместо lease root означает unknown, а не отсутствие owners', async (t) => {
  const input = await fixture(t);

  await fs.symlink(path.join(input.root, 'missing-foreign'), path.join(input.cacheDir, 'leases'));

  const result = await pruneServerCache(input);

  assert.deepEqual(result.deleted, [], 'ENOENT за чужой ссылкой не proof отсутствия lease');
  assert.ok(result.unknown.some((entry) => entry.packageId === IDS.C));
});
