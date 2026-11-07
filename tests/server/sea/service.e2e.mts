import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { verifySeaRuntime } from '../../../shared/node/seaRuntime.ts';
import { freePort, isolatedEnv } from '../helpers/pluginBootFixture.js';

const execute = promisify(execFile);

/**
 * Ждёт наблюдаемый результат только своей временной службы, без сигналов PID.
 * Общий срок ограничен, отсутствие API/освобождения lock становится отказом теста.
 */
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.fail(message);
}

test('SEA-SERVICE-01: отдельная настоящая user-служба запускает SEA и освобождает D (вне песочницы)', {
  timeout: 150000,
}, async (t) => {
  assert.equal(process.env.GRIGDESK_SEA_SYSTEMD, '1', 'Этот тест запускает Claude вне песочницы');

  const release = process.env.GRIGDESK_SERVER_RELEASE_DIR;

  assert.ok(release, 'Нужен GRIGDESK_SERVER_RELEASE_DIR');
  await verifySeaRuntime(release);

  const data = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-service-'));
  const unit = `grigdesk-sea-test-${randomUUID()}.service`;
  const port = await freePort();
  const mobilePort = await freePort();
  const environment = {
    ...isolatedEnv(data, port, mobilePort),
    PATH: `${path.join(release, 'runtime/node/bin')}:/usr/bin:/bin`,
  };
  let created = false;

  t.after(async () => {
    if (created) {
      await execute('systemctl', ['--user', 'stop', unit], { timeout: 50000 });
    }

    await rm(data, { recursive: true, force: true });
  });
  await mkdir(path.join(data, 'home'));
  await execute('systemd-run', [
    '--user', '--collect', `--unit=${unit}`,
    '--property=KillMode=mixed', '--property=TimeoutStopSec=45',
    '--property=Restart=always', '--property=RestartPreventExitStatus=78',
    '--property=UnsetEnvironment=NODE_OPTIONS',
    `--property=WorkingDirectory=${path.join(release, 'server')}`,
    '/usr/bin/env', '-i', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    path.join(release, 'server/grigdesk-server'),
  ], { timeout: 10000 });
  created = true;
  await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });

    return response.status === 401 && (await response.json() as { error: string }).error === 'unauthorized';
  }, 'Временная systemd-служба не подняла защищённый API');

  const result = await execute('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'], {
    timeout: 5000,
  });
  const pid = Number(result.stdout.trim());

  assert.ok(Number.isSafeInteger(pid) && pid > 0);

  const binary = await realpath(path.join(release, 'server/grigdesk-server'));

  assert.equal(await realpath(`/proc/${pid}/exe`), binary);
  await execute('systemctl', ['--user', 'stop', unit], { timeout: 50000 });
  created = false;
  await until(async () => await stat(path.join(data, 'state/server.lock')).catch(() => null) === null,
    'Служба не освободила lock D');
  await verifySeaRuntime(release);
});
