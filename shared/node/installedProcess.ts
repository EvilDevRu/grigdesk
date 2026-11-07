import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { InstallationReceipt } from './installedLayout.ts';

const execute = promisify(execFile);

/**
 * Helper и запускаемые им приложения получают самостоятельную cgroup пользователя.
 * Новый desktop/server не наследует время жизни ни старого окна, ни завершившегося worker.
 */
export async function launchInstalledProcess(
  receipt: InstallationReceipt, args: [string, string], suffix: string,
): Promise<void> {
  const [action, target] = args;
  const allowed = action === 'launch' ? ['desktop', 'server'].includes(target)
    : ['prepare', 'apply', 'recover', 'rollback'].includes(action)
      && /^[a-f0-9-]{36}$/u.test(target);

  if (!allowed || !/^[a-z0-9-]{1,100}$/u.test(suffix)) {
    throw new Error('release_helper_action_invalid');
  }

  const helper = path.join(receipt.root, 'update/maintenance');
  const logName = action === 'launch' ? target : suffix;
  const logFile = path.join(receipt.root, `update/${logName}.log`);
  let systemd = false;

  try {
    await execute('systemctl', ['--user', 'show-environment'], { timeout: 3000 });
    systemd = true;
  } catch {
    // При отсутствии user manager отдельная сессия не зависит от терминала родителя.
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

  const log = await fs.open(logFile, 'a', 0o600);

  try {
    const child = spawn(helper, args, {
      cwd: receipt.root,
      env: process.env,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
}
