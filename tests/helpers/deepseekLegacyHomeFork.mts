// Историческая fixture embedded cutover; production больше не импортирует этот код.
// Старые проверки сохраняются до завершения переходных тестов, без публикации runtime сервера.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

import { readDeepSeekArtifactAsync } from './deepseekLegacyArtifact.mts';

/**
 * Снимок проверяет обычные файлы и замкнутые ссылки, не публикуя имена или содержимое.
 * Изменение home во время копирования не разрешает объявить полученную копию согласованной.
 */
async function homeDigest(root: string, relative = ''): Promise<string> {
  const hash = createHash('sha256');

  for (const entry of (await fs.readdir(path.join(root, relative))).sort()) {
    const name = path.join(relative, entry);
    const file = path.join(root, name);
    const stat = await fs.lstat(file);

    hash.update(name);

    if (stat.isDirectory()) {
      hash.update(await homeDigest(root, name));
    } else if (stat.isFile()) {
      hash.update(await fs.readFile(file));
    } else if (stat.isSymbolicLink()) {
      const resolved = path.relative(root, await fs.realpath(file));

      if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
        throw new Error('Home содержит внешнюю ссылку');
      }

      hash.update(await fs.readlink(file));
    } else {
      throw new Error('Home содержит неподдерживаемый тип файла');
    }
  }

  return hash.digest('hex');
}

/**
 * Явный fork сохраняет исходный home и создаёт отдельную копию для проверенной generation.
 * Existing destination, busy изменение источника и несовместимый artifact дают отказ.
 */
export async function forkDeepSeekHome(sourceHome: string, destinationHome: string, generation: string) {
  if (![sourceHome, destinationHome, generation].every(path.isAbsolute)) {
    throw new Error('Пути fork должны быть абсолютными');
  }

  const { artifact } = await readDeepSeekArtifactAsync(generation);
  const source = await fs.realpath(sourceHome);
  const parent = path.dirname(destinationHome);
  const missing: string[] = [];
  let ancestor = parent;

  while (true) {
    try {
      ancestor = await fs.realpath(ancestor);

      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }

  const destination = path.join(ancestor, ...missing, path.basename(destinationHome));
  const relative = path.relative(source, destination);

  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)) {
    throw new Error('Destination не может находиться внутри исходного home');
  }

  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });

  try {
    await fs.lstat(destination);

    throw new Error('Destination уже существует; home не перезаписывается');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const staging = path.join(path.dirname(destination), `.home-fork-${randomUUID()}`);
  const before = await homeDigest(source);

  try {
    await fs.cp(source, staging, { recursive: true, verbatimSymlinks: true });
    await fs.chmod(staging, 0o700);

    if (await homeDigest(source) !== before || await homeDigest(staging) !== before) {
      throw new Error('Home изменился во время fork');
    }

    await fs.writeFile(path.join(staging, '.grigdesk-runtime.json'), JSON.stringify({
      buildId: artifact.buildId,
      journalFormat: artifact.journalFormat,
      sourceDigest: before,
    }), { mode: 0o600 });
    await fs.rename(staging, destination);

    return { buildId: artifact.buildId, sourceDigest: before };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
