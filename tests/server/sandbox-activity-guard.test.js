// Межпроцессная аренда песочницы: Showcase делит shared-lock, lifecycle требует
// exclusive, а переданный child fd удерживает замок после закрытия parent-копии.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createSandboxActivityGuard,
} from '../../server/src/lib/sandboxes/activityGuard.ts';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'sandbox-activity-'));

  t.after(() => rm(stateDir, { recursive: true, force: true }));

  return createSandboxActivityGuard({ stateDir, timeoutMs: 10 });
}

test('shared аренды совместимы, а lifecycle получает только exclusive доступ', async (t) => {
  const guard = await fixture(t);
  const first = await guard.acquireShowcase('990001');
  const second = await guard.acquireShowcase('990001');

  await assert.rejects(
    () => guard.acquireLifecycle('990001'),
    (error) => error.code === 'SANDBOX_ACTIVITY_BUSY',
  );

  await first.release();
  await second.release();

  const lifecycle = await guard.acquireLifecycle('990001');

  await assert.rejects(
    () => guard.acquireShowcase('990001'),
    (error) => error.code === 'SANDBOX_ACTIVITY_BUSY',
  );

  await lifecycle.release();
  await lifecycle.release();
  assert.throws(
    () => lifecycle.inheritedFd(),
    (error) => error.code === 'SANDBOX_ACTIVITY_LOST',
  );
});

test('унаследованный fd держит shared-lock после закрытия parent-копии', async (t) => {
  const guard = await fixture(t);
  const lease = await guard.acquireShowcase('990002');
  const code = [
    "const fs = require('node:fs');",
    'fs.fstatSync(3);',
    "process.stdout.write('READY\\n');",
    'setInterval(() => {}, 1000);',
  ].join('');
  const child = spawn(process.execPath, ['-e', code], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', lease.inheritedFd()],
  });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    }
  });

  const [chunk] = await once(child.stdout, 'data');

  assert.match(String(chunk), /READY/);
  await lease.release();

  await assert.rejects(
    () => guard.acquireLifecycle('990002'),
    (error) => error.code === 'SANDBOX_ACTIVITY_BUSY',
  );

  if (child.pid) {
    process.kill(-child.pid, 'SIGTERM');
  }
  await once(child, 'close');

  const lifecycle = await guard.acquireLifecycle('990002');

  await lifecycle.release();
});
