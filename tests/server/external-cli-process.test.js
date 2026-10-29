import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { once } from 'node:events';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { execFile, spawn, withExternalCliProcess }
  from '../../server/src/lib/providerInstall/externalCliProcess.ts';

const execute = promisify(execFile);

test('подготовленный внешний запуск берёт shell exports и сохраняет защитный overlay', async (t) => {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'external-cli-lifecycle/process-tests');

  await fs.mkdir(base, { recursive: true });

  const directory = await fs.mkdtemp(path.join(base, 'case-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const context = {
    providerId: 'fixture',
    executable: process.execPath,
    resourceKey: 'a'.repeat(64),
    leaseDirectory: directory,
    env: { PATH: '/usr/bin:/bin', USER_SHELL_VALUE: 'from-shell' },
  };
  const source = 'console.log(JSON.stringify({value:process.env.USER_SHELL_VALUE,guard:process.env.GUARD}))';
  const result = await withExternalCliProcess(context, () => execute(process.execPath, ['-e', source], {
    env: { ...process.env, GUARD: 'required-overlay' },
  }));

  assert.deepEqual(JSON.parse(result.stdout), { value: 'from-shell', guard: 'required-overlay' });

  const managed = await execute(process.execPath, ['-e', source], { env: { GUARD: 'managed-env' } });

  assert.deepEqual(JSON.parse(managed.stdout), { guard: 'managed-env' });

  await assert.rejects(withExternalCliProcess({ ...context, executableIdentity: '0'.repeat(64) },
    () => execute(process.execPath, ['-e', 'console.log("must-not-run")'])), (error) => {
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /installation_changed/);

    return true;
  });

  const child = withExternalCliProcess(context, () => spawn(process.execPath,
    ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const [output] = await once(child.stdout, 'data');
  const cliPid = Number(output.toString().trim());

  t.after(() => {
    try { process.kill(cliPid, 'SIGKILL'); } catch { /* Свой CLI уже вышел. */ }
  });

  const closed = once(child, 'close');

  child.kill('SIGKILL');
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 200))]);

  const stat = await fs.readFile(`/proc/${cliPid}/stat`, 'utf8').catch(() => '');

  assert.ok(!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'),
    'SIGKILL должен завершить собственный CLI вместе с helper');
});
