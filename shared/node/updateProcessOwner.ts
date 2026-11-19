import fs from 'node:fs/promises';
import path from 'node:path';

import { readInstallation, readInstalledPointer } from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { installationCandidate } from './bundleLayout.ts';
import { readDarwinProcessIdentity } from './processIdentity.ts';

export { installationForExecutableSync } from './bundleLayout.ts';

/**
 * Desktop и worker дополнительно проверяют current асинхронным reader до любых эффектов.
 * Исторические source/portable раскладки не становятся registered по одному имени папки.
 */
export async function installationForExecutable(executable: string): Promise<InstallationReceipt | null> {
  const root = installationCandidate(await fs.realpath(executable));

  if (!root) {
    return null;
  }

  const receipt = await readInstallation(root);

  await readInstalledPointer(receipt);

  return receipt;
}

/**
 * PID связывается с uid, временем старта и executable перед любым управлением.
 * Переиспользованный PID либо ошибка доступа не разрешают отправить сигнал.
 */
export async function readUpdateProcess(pid: number, maintenance?: string): Promise<{
  pid: number;
  starttime: string;
  executable: string;
}> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('release_process_owner_invalid');
  }

  if (process.platform === 'darwin') {
    const result = await readDarwinProcessIdentity(pid, maintenance);

    if (result.state === 'alive') {
      const { starttime, executable } = result.identity;

      return {
        pid,
        starttime,
        executable,
      };
    }

    const error = new Error('release_process_owner_invalid');

    throw result.state === 'dead' ? Object.assign(error, { code: 'ESRCH' }) : error;
  }

  const directory = `/proc/${pid}`;
  const stat = await fs.stat(directory);

  if (stat.uid !== process.getuid!()) {
    throw new Error('release_process_owner_invalid');
  }

  const text = await fs.readFile(path.join(directory, 'stat'), 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/u);
  const executable = await fs.readlink(path.join(directory, 'exe'));

  if (fields[0] === 'Z' || !/^\d+$/u.test(fields[19] ?? '')) {
    throw new Error('release_process_owner_invalid');
  }

  return {
    pid,
    starttime: fields[19]!,
    executable,
  };
}
