import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import type { InstallationReceipt } from './installedLayout.ts';
import { assertInstallationPath } from './installedLayout.ts';
import { rollbackAttemptPattern } from './darwinRollbackAttempt.ts';

const execute = promisify(execFile);

/**
 * Helper и запускаемые им приложения получают самостоятельную cgroup пользователя.
 * Новый desktop/server не наследует время жизни ни старого окна, ни завершившегося worker.
 */
export async function launchInstalledProcess(
  receipt: InstallationReceipt, args: [string, string] | [string, string, string], suffix: string,
  permit?: (child: ChildProcess) => Promise<void>,
): Promise<void> {
  const [action, target, attempt] = args;
  const darwin = process.platform === 'darwin';
  const bound = action === 'launch-update-desktop';
  const allowed = args.length === 3
    ? darwin && (action === 'rollback' || bound) && rollbackAttemptPattern.test(target)
      && rollbackAttemptPattern.test(attempt!)
    : action === 'launch' ? ['desktop', 'server'].includes(target)
      : ['prepare', 'apply', 'recover', ...(darwin ? [] : ['rollback'])].includes(action)
        && /^[a-f0-9-]{36}$/u.test(target);

  if (!allowed || bound !== Boolean(permit) || !/^[a-z0-9-]{1,100}$/u.test(suffix)) {
    throw new Error('release_helper_action_invalid');
  }

  const helper = path.join(receipt.root, 'update/maintenance');
  const logName = action === 'launch' ? target : suffix;
  const logFile = path.join(receipt.root, `update/${logName}.log`);
  let systemd = false;

  if (process.platform === 'linux') {
    try {
      await execute('systemctl', ['--user', 'show-environment'], { timeout: 3000 });
      systemd = true;
    } catch {
      // При отсутствии user manager отдельная сессия не зависит от терминала родителя.
    }
  }

  if (systemd) {
    const sessionKeys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
      'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL', 'LC_MESSAGES'];

    await execute('systemd-run', ['--user', '--quiet', '--collect',
      `--unit=grigdesk-${suffix}`, '--service-type=exec', `--working-directory=${receipt.root}`,
      `--property=StandardOutput=append:${logFile}`, '--property=StandardError=inherit',
      '--property=UMask=0077',
      ...sessionKeys.filter((key) => process.env[key]).map((key) => `--setenv=${key}=${process.env[key]}`),
      helper, ...args], { timeout: 10000 });

    return;
  }

  const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND
    | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const log = await fs.open(logFile, process.platform === 'darwin' ? flags : 'a', 0o600);

  try {
    let env = process.env;

    if (process.platform === 'darwin') {
      const stat = await log.stat();
      const named = await fs.lstat(logFile);

      if (!stat.isFile() || stat.uid !== receipt.uid || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
        || stat.dev !== named.dev || stat.ino !== named.ino) {
        throw new Error('installation_log_invalid');
      }

      await assertInstallationPath(receipt.root, 'update/maintenance');

      const sessionKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR',
        'LANG', 'LC_ALL', 'LC_MESSAGES'];

      env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

      for (const key of sessionKeys) {
        if (process.env[key]) {
          env[key] = process.env[key];
        }
      }
    }

    const child = spawn(helper, args, {
      cwd: receipt.root,
      env,
      detached: true,
      stdio: [permit ? 'pipe' : 'ignore', log.fd, log.fd],
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    if (permit) {
      child.stdin?.on('error', () => {});

      try {
        await permit(child);
      } catch (error) {
        child.stdin?.destroy();
        child.unref();

        throw error;
      }
    }

    child.unref();
  } finally {
    await log.close();
  }
}
