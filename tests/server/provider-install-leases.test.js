import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { acquireCliLease } from '../../server/src/lib/providerInstall/leases.ts';

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
