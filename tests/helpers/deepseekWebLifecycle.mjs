import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { prepareDeepSeekLifecycle } from './deepseekLifecycle.mts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';

/**
 * Каждый web-запуск владеет своим home, detached launcher и управляемой командой.
 * Готовность подтверждают PID и marker; уборка касается только созданных фикстурой процессов.
 */
export async function webFixture(t, { hang = false, boot = false, prepared } = {}) {
  const candidate = prepared ?? await prepareDeepSeekLifecycle();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-web-'));
  const launchDir = path.join(root, 'launch');
  const home = path.join(root, 'home');
  const overlayPath = path.join(launchDir, 'overlay.yml');
  let child;
  let childClosed;

  t.after(async () => {
    const pids = [
      child?.pid,
      Number(await fs.readFile(path.join(root, 'worker.pid'), 'utf8').catch(() => '')),
      Number(await fs.readFile(path.join(root, 'shell.pid'), 'utf8').catch(() => '')),
      Number(await fs.readFile(path.join(root, 'boot-gate.ready'), 'utf8').catch(() => '')),
    ].filter((pid) => Number.isSafeInteger(pid) && pid > 1);

    for (const pid of pids) {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

        process.kill(Number(fields[2]) === pid ? -pid : pid, 'SIGKILL');
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) {
          throw error;
        }
      }
    }

    await childClosed;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(launchDir);
  await fs.mkdir(home);
  await fs.writeFile(overlayPath, '- insert:\n    - id: managed-stop-fixture\n      name: '
    + `${JSON.stringify(pathToFileURL(candidate.plugin).href)}\n`);

  const config = {
    deepseekRuntimeMode: 'binary',
    deepseekBin: candidate.binary,
    deepseekCacheDir: candidate.cache,
    deepseekRuntimeHome: path.join(root, 'runtime'),
  };
  const runtime = await resolveDeepSeekRuntimeAsync(config);
  const options = {
    runtime,
    bin: candidate.binary,
    launch: { overlayPath, launchDir },
    overlayPath,
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      DSH_HOME: home,
      TMPDIR: root,
      DSH_TELEMETRY_DISABLED: '1',
      GRIGDESK_TEST_STOP_DIR: root,
      ...(hang ? { GRIGDESK_TEST_HANG_DISPOSAL: '1' } : {}),
      ...(boot ? { GRIGDESK_TEST_BOOT_GATE: path.join(root, 'boot-gate') } : {}),
    },
    spawnProcess: (...args) => {
      child = spawn(...args);
      childClosed = new Promise((resolve) => child.once('close', resolve));

      return child;
    },
  };

  /**
   * Web URL может появиться раньше остальных plugins: это ещё не готовность команды.
   * Отказ disposal проверяется только после собственного shell marker и containment.
   */
  async function ready() {
    const deadline = Date.now() + 30000;

    while (Date.now() < deadline) {
      const worker = Number(await fs.readFile(path.join(root, 'worker.pid'), 'utf8').catch(() => ''));
      const shell = Number(await fs.readFile(path.join(root, 'shell.pid'), 'utf8').catch(() => ''));
      const marker = await fs.readFile(path.join(root, 'marker'), 'utf8').catch(() => '');
      const containment = await fs.readFile(path.join(root, 'containment'), 'utf8').catch(() => '');

      if (worker > 1 && shell > 1 && marker.length > 0 && containment) {
        return {
          worker,
          shell,
          containment,
        };
      }

      await pause(25);
    }

    assert.fail('Настоящая managed shell не достигла собственного marker');
  }

  return {
    options,
    config,
    root,
    ready,
    launcher: () => child,
  };
}

