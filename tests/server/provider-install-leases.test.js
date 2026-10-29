import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import {
  acquireCliLease, inspectCliLeases, terminateCliLeaseHolders,
} from '../../server/src/lib/providerInstall/leases.ts';

/**
 * Приватные records лежат в одноразовом каталоге; процессов пользователей здесь нет.
 * Два владельца имитируют idle-агента и короткий probe одной физической установки.
 */
async function fixture(t) {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'external-cli-lifecycle/lease-tests');

  await fs.mkdir(base, { recursive: true });

  const directory = await fs.mkdtemp(path.join(base, 'case-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  return {
    directory,
    providerId: 'fixture',
    resourceKey: 'a'.repeat(64),
  };
}

test('живые shared readers запрещают exclusive, после обоих release обслуживание разрешено', async (t) => {
  const input = await fixture(t);
  const first = await acquireCliLease({ ...input, mode: 'reader' });
  const second = await acquireCliLease({ ...input, mode: 'reader' });

  await assert.rejects(acquireCliLease({ ...input, mode: 'exclusive' }), { code: 'provider_in_use' });
  await first.release();
  await assert.rejects(acquireCliLease({ ...input, mode: 'exclusive' }), { code: 'provider_in_use' });
  await second.release();

  const writer = await acquireCliLease({ ...input, mode: 'exclusive' });

  await assert.rejects(acquireCliLease({ ...input, mode: 'reader' }), { code: 'provider_maintenance' });
  await writer.release();
});

test('exclusive закрывает неизвестный alias, соседний исполнитель работает', async (t) => {
  const input = await fixture(t);
  const writer = await acquireCliLease({ ...input, mode: 'exclusive' });

  await assert.rejects(acquireCliLease({
    ...input,
    resourceKey: 'b'.repeat(64),
    mode: 'reader',
  }),
    { code: 'provider_maintenance' });

  const neighbor = await acquireCliLease({
    ...input,
    providerId: 'neighbor',
    mode: 'reader',
  });

  await neighbor.release();
  await writer.release();
  await writer.release();

  const reader = await acquireCliLease({ ...input, mode: 'reader' });

  await reader.release();
});

test('одновременные writer/reader получают взаимоисключающие права', async (t) => {
  const input = await fixture(t);
  const results = await Promise.allSettled([
    acquireCliLease({ ...input, mode: 'exclusive' }),
    acquireCliLease({ ...input, mode: 'reader' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      await result.value.release();
    }
  }
});

test('helper удерживает reader после SIGKILL holder, пока запущенный CLI жив', async (t) => {
  const input = await fixture(t);
  const helperFile = fileURLToPath(new URL('../../server/scripts/externalCliLease.mts', import.meta.url));
  const helper = spawn(process.execPath, [helperFile,
    '--lease-dir', input.directory, '--provider', input.providerId, '--resource', input.resourceKey,
    '--', process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000);'],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  t.after(() => {
    try { process.kill(-helper.pid, 'SIGKILL'); } catch { /* Своя группа уже вышла. */ }
  });

  const [output] = await once(helper.stdout, 'data');
  const childPid = Number(output.toString().trim());

  assert.ok(childPid > 0);
  await assert.rejects(acquireCliLease({ ...input, mode: 'exclusive' }), { code: 'provider_in_use' });

  const closed = once(helper, 'exit');

  helper.kill('SIGKILL');
  await closed;
  await assert.rejects(acquireCliLease({ ...input, mode: 'exclusive' }), { code: 'provider_in_use' });
  process.kill(childPid, 'SIGKILL');

  let writer;

  for (let attempt = 0; attempt < 50 && !writer; attempt += 1) {
    writer = await acquireCliLease({ ...input, mode: 'exclusive' }).catch(() => null);

    if (!writer) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  assert.ok(writer, 'после доказанного выхода child запись reclaim-ится');
  await writer.release();
});

test('pending writer закрывает новых readers и получает копию после release', async (t) => {
  const input = await fixture(t);
  const reader = await acquireCliLease({ ...input, mode: 'reader' });
  const writerPromise = acquireCliLease({ ...input, mode: 'exclusive' });

  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(acquireCliLease({ ...input, mode: 'reader' }),
    { code: 'provider_maintenance' });

  await reader.release();

  const writer = await writerPromise;

  await writer.release();
});

async function startTimeOf(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');

  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19];
}

async function recordsFileOf(input) {
  const directory = path.join(input.directory,
    createHash('sha256').update(input.providerId).digest('hex'));

  return path.join(directory, 'records.json');
}

test('inspect показывает живых readers с меткой чата и вычищает протухшие записи', async (t) => {
  const input = await fixture(t);
  const reader = await acquireCliLease({
    ...input,
    mode: 'reader',
    jobId: 'smvsfi95843y',
  });

  const holders = await inspectCliLeases(input);

  assert.equal(holders.length, 1);
  assert.equal(holders[0].ownerPid, process.pid);
  assert.equal(holders[0].chatKey, 'smvsfi95843y');
  assert.ok(holders[0].ageSeconds >= 0);

  await reader.release();

  const emptied = await inspectCliLeases(input);

  assert.deepEqual(emptied, []);
});

test('inspect убирает запись мёртвого holder, блокировавшего exclusive', async (t) => {
  const input = await fixture(t);
  const dead = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  const starttime = await startTimeOf(dead.pid);
  const exited = once(dead, 'exit');

  dead.kill('SIGKILL');
  await exited;

  const owner = {
    pid: dead.pid,
    starttime,
    token: 'dead-holder',
  };

  assert.equal(await fs.access(`/proc/${dead.pid}`).then(() => true, () => false), false);

  await fs.mkdir(path.dirname(await recordsFileOf(input)), { recursive: true });
  await fs.writeFile(await recordsFileOf(input), JSON.stringify([{
    resourceKey: input.resourceKey,
    owner,
    mode: 'reader',
    phase: 'active',
    child: null,
    sessionId: null,
    jobId: null,
  }]));

  const holders = await inspectCliLeases(input);

  assert.deepEqual(holders, []);
  assert.deepEqual(JSON.parse(await fs.readFile(await recordsFileOf(input), 'utf8')), []);
});

test('terminate закрывает живую цепочку holder/CLI по подтверждению и снимает запись', async (t) => {
  const input = await fixture(t);
  // Detached node-процесс повторяет реального helper: собственная сессия и группа,
  // а записанный child — «CLI», который переживает группу теста.
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'],
    { detached: true, stdio: 'ignore' });

  t.after(() => {
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* Группа уже завершилась. */ }
  });

  const child = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid));'
    + ' setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const childPid = Number((await once(child.stdout, 'data')).toString());

  await fs.mkdir(path.dirname(await recordsFileOf(input)), { recursive: true });
  await fs.writeFile(await recordsFileOf(input), JSON.stringify([{
    resourceKey: input.resourceKey,
    owner: {
      pid: holder.pid,
      starttime: await startTimeOf(holder.pid),
      token: 'live-holder',
    },
    mode: 'reader',
    phase: 'active',
    child: {
      pid: childPid,
      starttime: await startTimeOf(childPid),
      token: 'live-holder',
    },
    sessionId: holder.pid,
    jobId: 'smvsh2vwj3uw',
  }]));

  const before = await inspectCliLeases(input);

  assert.equal(before.length, 1);
  assert.equal(before[0].chatKey, 'smvsh2vwj3uw');

  await terminateCliLeaseHolders(input);

  const holderDead = await fs.access(`/proc/${holder.pid}`).then(() => false, () => true);
  const childDead = await fs.access(`/proc/${childPid}`).then(() => false, () => true);

  assert.ok(holderDead, 'группа holder завершена');
  assert.ok(childDead, 'записанный child завершён');
  assert.deepEqual(await inspectCliLeases(input), []);

  const writer = await acquireCliLease({ ...input, mode: 'exclusive' });

  await writer.release();
});
