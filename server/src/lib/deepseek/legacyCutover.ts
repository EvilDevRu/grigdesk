import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { acquireDirectoryLock } from '../../../../shared/node/directoryLock.ts';
import { syncDirectory } from '../../../../shared/node/files.ts';
import { canonicalJson } from '../../../../shared/lib/canonicalJson.ts';

export interface LegacyHomeCutover {
  directory: string;
  legacyDirectory: string;
  provider: 'deepseek' | 'glm';
  legacyIdentity: string;
}

/**
 * Первый binary запуск переносит только home выбранной установленной legacy identity.
 * Receipt позволяет закончить marker после прерывания между rename home и marker.
 */
export async function adoptLegacyChatHome(options: LegacyHomeCutover): Promise<void> {
  const { directory, legacyDirectory, provider, legacyIdentity } = options;

  if (![directory, legacyDirectory].every(path.isAbsolute) || !/^[a-f0-9]{64}$/u.test(legacyIdentity)
    || directory === legacyDirectory) {
    throw new Error('Некорректный путь или identity переноса памяти');
  }

  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });

  const lock = await acquireDirectoryLock(`${directory}.cutover-lock`);
  const receipt = `${directory}.cutover.json`;

  try {
    const target = await statOrNull(directory);
    const source = await statOrNull(legacyDirectory);
    const pending = await statOrNull(receipt);

    if ([target, source].some((entry) => entry && (!entry.isDirectory()
      || typeof process.getuid === 'function' && entry.uid !== process.getuid()))) {
      throw new Error('Каталог переноса памяти не может быть ссылкой или обычным файлом');
    }

    if (pending) {
      if (!pending.isFile() || (pending.mode & 0o777) !== 0o600
        || typeof process.getuid === 'function' && pending.uid !== process.getuid()
        || canonicalJson(JSON.parse(await fs.readFile(receipt, 'utf8'))) !== canonicalJson(options)) {
        throw new Error('Перенос памяти имеет чужой или повреждённый receipt');
      }
    }

    if (target) {
      if (pending && !source) {
        await finishMarker(options, receipt);
      }

      return;
    }

    if (!source) {
      return;
    }

    await assertLegacyMarker(options);

    if (!pending) {
      await fs.writeFile(receipt, JSON.stringify(options), { flag: 'wx', mode: 0o600 });
    }

    await fs.rename(legacyDirectory, directory);
    await finishMarker(options, receipt);
  } finally {
    await lock.release();
  }
}
/**
 * Только ENOENT означает отсутствие home; ошибки доступа сохраняют память закрытой.
 * lstat не следует ссылке, поэтому чужой target не становится каталогом переноса.
 */
async function statOrNull(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * Прежний marker, если он был, обязан относиться к выбранной legacy identity.
 * Отсутствие marker допустимо для исходных embedded homes, которые его не создавали.
 */
async function assertLegacyMarker(options: LegacyHomeCutover): Promise<void> {
  const markerPath = path.join(options.legacyDirectory, '.grigdesk-runtime.json');
  const markerStat = await statOrNull(markerPath);

  if (!markerStat) {
    return;
  }

  if (!markerStat.isFile()) {
    throw new Error('Прежний marker не может быть ссылкой');
  }

  let marker;

  try {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  if (options.provider !== 'deepseek' || marker.buildId !== options.legacyIdentity
    || marker.journalFormat !== 1) {
    throw new Error('Прежний home закреплён за другой identity');
  }
}

/**
 * Новый marker публикуется атомарно после rename home; журнал не переписывается.
 * Receipt удаляется только после синхронизации новой записи, чтобы повтор мог закончить перенос.
 */
async function finishMarker(options: LegacyHomeCutover, receipt: string): Promise<void> {
  const temporary = path.join(options.directory, `.grigdesk-runtime-${randomUUID()}.tmp`);

  await fs.chmod(options.directory, 0o700);

  try {
    await fs.writeFile(temporary, JSON.stringify({ format: 1, provider: options.provider }), {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporary, path.join(options.directory, '.grigdesk-runtime.json'));
    await syncDirectory(options.directory);
    await fs.rm(receipt);
    await syncDirectory(path.dirname(options.directory));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Identity переноса берётся только у установленного current, а не у нового ELF.
 * Отсутствующая legacy установка не требует миграции home или binding.
 */
export async function installedLegacyBuildId(config: {
  rootDir?: string;
  deepseekGenerationRoot?: string;
}): Promise<string | null> {
  const runtimeRoot = config.deepseekGenerationRoot
    ?? (config.rootDir ? path.join(config.rootDir, 'server/runtime/deepseek') : null);

  if (!runtimeRoot) {
    return null;
  }

  if (!path.isAbsolute(runtimeRoot)) {
    throw new Error('Legacy runtime root должен быть абсолютным');
  }

  const current = path.join(runtimeRoot, 'current');

  if (!await statOrNull(current)) {
    return null;
  }

  const root = await fs.realpath(runtimeRoot);
  const generation = await fs.realpath(current);
  const buildId = path.basename(generation);

  if (!/^[a-f0-9]{64}$/u.test(buildId) || generation !== path.join(root, 'builds', buildId)) {
    throw new Error('Legacy current находится вне установленного поколения');
  }

  const header = JSON.parse(await fs.readFile(path.join(generation, 'runtime.json'), 'utf8'));

  if (header.format !== 1 || header.buildId !== buildId) {
    throw new Error('Legacy current имеет повреждённый заголовок');
  }

  return buildId;
}
