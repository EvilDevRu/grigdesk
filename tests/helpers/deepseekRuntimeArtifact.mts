// Только legacy fixtures первого перехода: Node22 generation не выбирается production resolver.
// Общие transport/parity наборы получают автономный ELF через deepseekBinary.mts.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../../shared/node/hash.ts';

import { deepSeekBuildInputs, hashRuntimePayload } from '../../deepseek/scripts/buildRuntime.mts';

import { readDeepSeekArtifact } from '../helpers/deepseekLegacyArtifact.mts';
import { artifactsPath, dataHome } from '../../shared/runtime/dataHome.ts';
import { deepSeekPackagePaths } from '../../deepseek/scripts/paths.ts';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Проверяется весь candidate, поэтому неизменный entry не скрывает повреждение dependency.
 * Внешний путь разрешён только как явно переданный тестовый артефакт.
 */
export async function verifyTestDeepSeekArtifact(directory: string): Promise<Record<string, any>> {
  readDeepSeekArtifact(directory);

  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'runtime.json'), 'utf8'));

  if (metadata.format !== 1 || metadata.hostContract !== 1 || metadata.entry !== 'entry.mjs') {
    throw new Error('Несовместимый контракт test DeepSeek artifact');
  }

  const payload = await hashRuntimePayload(directory);

  if (JSON.stringify(payload) !== JSON.stringify(metadata.payload)) {
    throw new Error('Повреждён test DeepSeek artifact');
  }

  return metadata;
}

/**
 * Один candidate строится под exclusive lock и переиспользуется по всем исходным входам.
 * Отсутствие подготовленных зависимостей является отказом, а не skip или скрытой загрузкой.
 */
export async function ensureTestDeepSeekArtifact(): Promise<string> {
  const explicit = process.env.GRIGDESK_TEST_DEEPSEEK_ARTIFACT;

  if (explicit) {
    await verifyTestDeepSeekArtifact(path.resolve(explicit));

    return path.resolve(explicit);
  }

  if (!process.env.GRIGDESK_ARTIFACTS_DIR) {
    const selected = dataHome({
      env: process.env,
      home: os.homedir(),
    });
    const exists = await fs.stat(selected).then((info) => info.isDirectory(), () => false);

    if (!exists) {
      throw new Error('Папки данных нет: задайте GRIGDESK_ARTIFACTS_DIR для тестового runtime.');
    }
  }

  const inputs = await deepSeekBuildInputs(deepSeekPackagePaths().vendorDir);
  const identity = sha256(JSON.stringify(inputs));
  const cache = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'deepseek-vendoring/test-builds');
  const directory = path.join(cache, identity);
  const lock = `${directory}.lock`;

  await fs.mkdir(cache, { recursive: true });

  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (await fs.access(path.join(directory, 'runtime.json')).then(() => true, () => false)) {
      await verifyTestDeepSeekArtifact(directory);

      return directory;
    }

    try {
      await fs.mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    try {
      const handle = await fs.open(`${directory}.log`, 'w', 0o600);

      try {
        const child = spawn(process.execPath, ['--max-old-space-size=4096',
          deepSeekPackagePaths().scripts.runtime, '--output-dir', directory], {
          cwd: repositoryRoot,
          stdio: ['ignore', handle.fd, handle.fd],
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        });

        if (code !== 0) {
          throw new Error(`Сборка DeepSeek завершилась ${code}; журнал ${directory}.log. `
            + 'Подготовка: npm ci --include=dev --prefix deepseek/build/runtime-deps');
        }
      } finally {
        await handle.close();
      }

      await verifyTestDeepSeekArtifact(directory);

      return directory;
    } finally {
      await fs.rmdir(lock);
    }
  }

  throw new Error('Таймаут ожидания сборки test DeepSeek artifact');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await ensureTestDeepSeekArtifact());
}
