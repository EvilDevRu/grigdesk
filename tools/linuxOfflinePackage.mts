import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Плоские имена задают состав локального источника для ZIP и deb.
 * Имя индекса соответствует тому же каналу, что закреплён в скрипте.
 */
export function offlinePackageFiles(channel: 'release' | 'dev') {
  return [
    'grigdesk-install', 'grigdesk-install.sha256', 'grigdesk-install.sig',
    'grigdesk-maintenance.gz', `${channel}.json`, 'desktop.tar.gz', 'server.tar.gz', 'control.tar.gz',
  ];
}

/**
 * Упаковывает плоский набор обычных файлов без повторного сжатия.
 * Вызывающий передаёт закрытую опись и путь в своей временной папке.
 */
export async function zipStore(source: string, output: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const stat = await fs.lstat(path.join(source, file)).catch(() => null);

    if (!stat?.isFile()) {
      throw new Error(`offline_input_invalid: ${file}`);
    }
  }

  await execute('7z', ['a', '-tzip', '-mx=0', path.resolve(output), ...files], {
    cwd: source,
    timeout: 180_000,
  });
}

/**
 * Создаёт ZIP рядом с входными файлами.
 * Внешнее имя появляется только после успешного завершения архиватора.
 */
export async function buildStableLinuxZip(directory: string, version: string): Promise<string> {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error('offline_zip_version_invalid');
  }

  const name = `grigdesk-${version}-linux-x64-offline.zip`;
  const output = path.join(directory, name);
  const work = await fs.mkdtemp(path.join(directory, '.offline-zip-'));

  try {
    const partial = path.resolve(work, name);

    await zipStore(directory, partial, offlinePackageFiles('release'));
    await fs.rename(partial, output);

    return output;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const directory = path.resolve(process.argv[2] ?? 'release-artifacts');
  const version = process.env.GRIGDESK_RELEASE_VERSION ?? '';

  process.stdout.write(`${await buildStableLinuxZip(directory, version)}\n`);
}
