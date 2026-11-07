import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { dataHome } from '../shared/runtime/dataHome.ts';

interface Timing {
  id: string;
  durationMs: number;
}

interface TimingInput {
  dataHome: string;
  variant: string;
  ids: readonly string[];
}

/**
 * Журнал создаётся до запуска сборщика, ссылка публикуется атомарной заменой.
 * Ротация удаляет только собственные обычные файлы и не затрагивает чужие артефакты.
 */
export async function openBuildLog(input: { env: NodeJS.ProcessEnv; home: string }) {
  const directory = path.join(dataHome(input), 'artifacts/ctl-build');
  const name = `build-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID()}.log`;
  const file = path.join(directory, name);

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const handle = await open(file, 'wx', 0o600);
  const temporary = path.join(directory, `.latest-${randomUUID()}`);

  try {
    await symlink(name, temporary);
    await rename(temporary, path.join(directory, 'latest.log'));

    const own = [];

    for (const entry of await readdir(directory)) {
      if (/^build-.*\.log$/.test(entry)) {
        const info = await lstat(path.join(directory, entry));

        if (info.isFile()) {
          own.push({ entry, time: info.birthtimeMs });
        }
      }
    }

    own.sort((a, b) => b.time - a.time || b.entry.localeCompare(a.entry));

    for (const { entry } of own.slice(10)) {
      await unlink(path.join(directory, entry));
    }
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => {});

    throw error;
  }

  let pending = Promise.resolve();

  return {
    path: file,
    write(bytes: string | Buffer): Promise<void> {
      pending = pending.then(async () => {
        await handle.writeFile(bytes);
      });

      return pending;
    },
    async close(): Promise<void> {
      try {
        await pending;
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * Повреждённый файл истории равносилен первому запуску с грубыми оценками.
 * Веса пригодны только для того же варианта и того же упорядоченного набора стадий.
 */
export async function readBuildTimings(input: TimingInput): Promise<Timing[] | null> {
  try {
    const history = JSON.parse(await readFile(
      path.join(input.dataHome, 'state/ctl-build-timings.json'), 'utf8',
    ));
    const steps = history.variants?.[input.variant];

    if (history.version !== 1 || !Array.isArray(steps) || steps.length !== input.ids.length) {
      return null;
    }

    return steps.every((step: Timing, index: number) => step?.id === input.ids[index]
      && Number.isFinite(step.durationMs) && step.durationMs > 0) ? steps : null;
  } catch {
    return null;
  }
}

/**
 * Только общий успех заменяет историю; отказ и прерывание сохраняют прежние байты.
 * Временный файл находится рядом с итогом, поэтому rename остаётся атомарным.
 */
export async function saveBuildTimings(input: TimingInput & {
  steps: Timing[];
  outcome: string;
}): Promise<void> {
  if (input.outcome !== 'success') {
    return;
  }

  const file = path.join(input.dataHome, 'state/ctl-build-timings.json');
  let variants: Record<string, Timing[]> = {};

  try {
    const old = JSON.parse(await readFile(file, 'utf8'));

    if (old.version === 1 && old.variants && typeof old.variants === 'object'
      && !Array.isArray(old.variants)) {
      variants = old.variants;
    }
  } catch {
    // Отсутствующая или повреждённая история не мешает записать успешный замер.
  }

  variants[input.variant] = input.steps;

  const temporary = `${file}.${randomUUID()}.tmp`;

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

  try {
    await writeFile(temporary, JSON.stringify({ version: 1, variants }) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
