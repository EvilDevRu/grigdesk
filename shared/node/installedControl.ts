import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { assertInstallationPath, readInstallation, readInstallationJson, readInstalledPointer }
  from './installedLayout.ts';
import { sha256File } from './hash.ts';
import type { InstalledUpdateJob } from './installedUpdateState.ts';
import type { ReleaseEnvelope } from '../runtime/installedUpdateContracts.ts';

export interface ControlStatus {
  channel: 'release' | 'dev';
  source: 'channel' | 'candidate-file' | 'local-test';
  installed: { desktop: string | null; server: string | null };
  check: {
    state: 'unknown' | 'checking' | 'current' | 'available' | 'error';
    checkedAt: string | null;
    error: string | null;
    envelope: ReleaseEnvelope | null;
    manifestDigest: string | null;
  };
  job: InstalledUpdateJob | null;
  workerActive: boolean;
}

type Action = 'status' | 'check' | 'set-channel' | 'create-job' | 'prepare'
  | 'handoff' | 'resume-handoff' | 'apply' | 'recover' | 'boot-proof';

/**
 * Выбирает Go IPC по зарегистрированному указателю текущей установки.
 * Старые поколения A до fence продолжают обслуживать их прежний протокол.
 */
export async function usesInstalledControl(root: string): Promise<boolean> {
  return (await readInstalledPointer(await readInstallation(root))).format === 2;
}

/**
 * Перед каждым запросом сверяет приватную привязку стабильного helper и точные байты файла.
 * Закрытые DTO поступают из main и CLI, общий порт принимает только известные действия.
 */
export async function installedControl<T>(
  root: string, action: Action, input: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  const receipt = await readInstallation(root);
  const helper = await assertInstallationPath(root, 'update/maintenance');
  const binding = await readInstallationJson(root, 'update/maintenance.json') as {
    schema: number;
    installationId: string;
    size: number;
    sha256: string;
  };

  if (Object.keys(binding).sort().join(',') !== 'installationId,schema,sha256,size'
    || binding.schema !== 1 || binding.installationId !== receipt.installationId
    || !Number.isSafeInteger(binding.size) || !/^[a-f0-9]{64}$/u.test(binding.sha256)) {
    throw new Error('maintenance_binding_invalid');
  }

  const stat = await lstat(helper);

  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o177) !== 0o100
    || stat.size !== binding.size || await sha256File(helper) !== binding.sha256) {
    throw new Error('maintenance_executable_invalid');
  }

  const env = { ...process.env };

  for (const variable of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'APPIMAGE', 'APPDIR']) {
    delete env[variable];
  }

  const work = path.resolve(root);
  const signal = AbortSignal.timeout(action === 'prepare' ? 600_000 : 40_000);

  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['control', action, '--json'], {
      cwd: work,
      env,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;

    // Структурированные ошибки helper сохраняют машинный код между desktop и CLI.
    // Вывод обеих труб ограничен перед JSON.parse.
    const push = (target: Buffer[], data: Buffer) => {
      bytes += data.length;

      if (bytes > 2 * 1024 * 1024) {
        child.kill();
        reject(new Error('maintenance_response_limit'));
      } else {
        target.push(data);
      }
    };

    child.stdout.on('data', (data: Buffer) => push(stdout, data));
    child.stderr.on('data', (data: Buffer) => push(stderr, data));
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      try {
        if (code !== 0) {
          const failure: { code?: unknown } = JSON.parse(Buffer.concat(stderr).toString());

          reject(new Error(typeof failure.code === 'string' ? failure.code : 'maintenance_failed'));

          return;
        }

        resolve(JSON.parse(Buffer.concat(stdout).toString()) as T);
      } catch (error) {
        reject(new Error('maintenance_response_invalid', { cause: error }));
      }
    });
    child.stdin.end(JSON.stringify({ ...input, schema: 1 }));
  });
}
