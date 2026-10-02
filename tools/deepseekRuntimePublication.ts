import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { deepSeekRuntimeError, readDeepSeekArtifact } from '../server/src/lib/deepseek/runtimeArtifact.ts';

type SavedGeneration = 'absent' | 'valid' | 'damaged';

const ABANDONED_LOCK_MS = 60_000;

/**
 * Переключение current происходит только после проверки сохранённого поколения.
 * Старые builds остаются доступны процессам и совместимому ручному откату.
 */
export async function activateDeepSeekGeneration(runtimeRoot: string, buildId: string): Promise<void> {
  if (!path.isAbsolute(runtimeRoot) || !/^[a-f0-9]{64}$/u.test(buildId)) {
    throw new Error('Некорректный runtime root или buildId');
  }

  const generation = path.join(runtimeRoot, 'builds', buildId);
  const { root, artifact } = readDeepSeekArtifact(generation);

  // readDeepSeekArtifact возвращает realpath: корень за символической ссылкой не ошибка.
  if (root !== path.join(await fs.realpath(runtimeRoot), 'builds', buildId) || artifact.buildId !== buildId) {
    throw new Error('Поколение не соответствует immutable build path');
  }

  const temporary = path.join(runtimeRoot, `.current-${randomUUID()}`);

  try {
    await fs.symlink(`builds/${buildId}`, temporary);
    await fs.rename(temporary, path.join(runtimeRoot, 'current'));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Владелец lock брошен, только если его процесс доказанно завершился (ESRCH) или owner.json
 * так и не появился за минуту после mkdir. EPERM и прочие ответы kill считаются живым процессом.
 */
async function publishLockOwner(lock: string): Promise<{ abandoned: boolean; pid: number | null }> {
  let pid: number | null = null;

  try {
    const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));

    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      pid = owner.pid;
    }
  } catch { /* Нет или битый owner.json: решает возраст lock. */ }

  if (pid === null) {
    let mtimeMs: number;

    try {
      ({ mtimeMs } = await fs.lstat(lock));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Владелец уже снял lock между mkdir и проверкой: повторный захват честен.
        return { abandoned: true, pid };
      }

      throw error;
    }

    return { abandoned: Date.now() - mtimeMs > ABANDONED_LOCK_MS, pid };
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    return { abandoned: (error as NodeJS.ErrnoException).code === 'ESRCH', pid };
  }

  return { abandoned: false, pid };
}

/**
 * Lock публикации или подготовки берётся mkdir и сразу получает owner.json с pid процесса.
 * Брошенный после kill или Ctrl-C lock снимается один раз; живой владелец даёт понятный отказ.
 */
export async function acquireDeepSeekLock(
  lock: string,
  busy = { code: 'deepseek_runtime_publish_locked', message: 'Публикация runtime DeepSeek уже идёт' },
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      const owner = await publishLockOwner(lock);

      if (attempt > 0 || !owner.abandoned) {
        const holder = owner.pid === null ? 'владелец ещё не записан' : `pid ${owner.pid}`;

        throw deepSeekRuntimeError(busy.code, `${busy.message} (${holder})`);
      }

      await fs.rm(lock, { recursive: true, force: true });
      continue;
    }

    try {
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), {
        mode: 0o600,
      });
    } catch (error) {
      await fs.rm(lock, { recursive: true, force: true });

      throw error;
    }

    return;
  }
}

/**
 * Сохранённое поколение с тем же buildId переиспользуется только целым. Повреждённое
 * заменяется проверенной копией кандидата, иначе обновление никогда не починило бы runtime.
 */
async function savedGenerationState(destination: string, buildId: string): Promise<SavedGeneration> {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent';
    }

    throw error;
  }

  try {
    const saved = readDeepSeekArtifact(destination);

    if (saved.artifact.buildId !== buildId) {
      throw new Error('Build path уже занят другой сборкой');
    }

    return 'valid';
  } catch (error) {
    if ((error as { code?: string }).code === 'deepseek_runtime_corrupt') {
      return 'damaged';
    }

    throw error;
  }
}

/**
 * Публикация копирует самодостаточное поколение и проверяет копию до переключения.
 * Сбой копирования или несовместимость оставляет прежний current без изменений.
 */
export async function publishDeepSeekGeneration(source: string, runtimeRoot: string) {
  if (!path.isAbsolute(runtimeRoot)) {
    throw new Error('runtime root должен быть абсолютным');
  }

  const { root, artifact } = readDeepSeekArtifact(source);
  const builds = path.join(runtimeRoot, 'builds');

  await fs.mkdir(builds, { recursive: true });

  const lock = path.join(runtimeRoot, '.publish-lock');

  await acquireDeepSeekLock(lock);

  const temporary = path.join(builds, `.candidate-${randomUUID()}`);
  const damaged = path.join(builds, `.damaged-${randomUUID()}`);
  const destination = path.join(builds, artifact.buildId);

  try {
    const saved = await savedGenerationState(destination, artifact.buildId);

    if (saved !== 'valid') {
      await fs.cp(root, temporary, { recursive: true, verbatimSymlinks: true });
      readDeepSeekArtifact(temporary);

      if (saved === 'damaged') {
        await fs.rename(destination, damaged);
      }

      await fs.rename(temporary, destination);
    }

    await activateDeepSeekGeneration(runtimeRoot, artifact.buildId);

    return {
      buildId: artifact.buildId,
      runtimeVersion: artifact.runtimeVersion,
      generationDir: destination,
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.rm(damaged, { recursive: true, force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
}
