import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { openArtifactDirectory } from '../../../../shared/node/artifactRemoval.ts';
import { CHAT_ARTIFACT_RUNS } from '../../../../shared/node/chatArtifactLayout.ts';
import { acquireDirectoryLock } from '../../../../shared/node/directoryLock.ts';
import { sha256 } from '../../../../shared/node/hash.ts';
import { writeDurableFile } from '../durableFile.ts';
import { PROFILE_RE } from '../profiles.ts';

export const CHAT_ARTIFACT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const RUN_ID = /^run-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const OWNER_ID = /^[a-f0-9]{64}$/u;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

interface Identity {
  dev: number;
  ino: number;
}

interface RunRecord {
  base: string;
  baseIdentity: Identity;
  identity: Identity;
  finishedAt: number | null;
}

interface RunRoot {
  key: string;
  path: string;
  label: string;
  fixed: true;
}

interface RunEntry {
  id: string;
  file: string;
  record: RunRecord;
}

function identityOf(stat: Stats): Identity {
  return { dev: stat.dev, ino: stat.ino };
}

function hasIdentity(stat: Stats, expected: Identity): boolean {
  return stat.isDirectory() && stat.dev === expected.dev && stat.ino === expected.ino;
}

function present(file: string): Promise<Stats | null> {
  return fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });
}

/**
 * Создаёт дочерний каталог относительно открытого родителя. Ссылки внутри
 * хранилища не могут перенаправить запись в другой каталог.
 */
async function makeRun(base: string, parts: readonly string[], id: string) {
  const handles = [await fs.open(base, DIRECTORY_FLAGS)];
  let parent = handles[0]!;

  try {
    for (const part of parts) {
      const child = `/proc/self/fd/${parent.fd}/${part}`;

      await fs.mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      });
      parent = await fs.open(child, DIRECTORY_FLAGS);
      handles.push(parent);
    }

    const anchored = `/proc/self/fd/${parent.fd}`;
    const directory = path.join(base, ...parts);

    if (await fs.realpath(anchored) !== directory) {
      throw new Error('Папка артефактов заменена');
    }

    const pending = path.join(anchored, id);

    await fs.mkdir(pending, { mode: 0o700 });

    return {
      base: directory,
      baseIdentity: identityOf(await parent.stat()),
      identity: identityOf(await fs.lstat(pending)),
      finishedAt: null,
    };
  } finally {
    for (const handle of handles.reverse()) {
      await handle.close();
    }
  }
}

export class ChatArtifactRuns {
  private readonly index: string;
  private readonly sharedRoot: string;

  constructor(index: string, sharedRoot: string) {
    this.index = index;
    this.sharedRoot = sharedRoot;
  }

  /**
   * Связь запуска с чатом записывает сервер до передачи каталога исполнителю.
   * Идентификатор проекта группирует данные в общем хранилище, отдельно от репозиториев.
   */
  async begin(chatKey: string, id: string, projectId: string | null) {
    if (!RUN_ID.test(id)) {
      throw new Error('Неизвестный формат идентификатора запуска');
    }

    if (projectId !== null && !PROFILE_RE.test(projectId)) {
      throw new Error('Неизвестный формат идентификатора проекта');
    }

    await fs.mkdir(this.sharedRoot, { recursive: true, mode: 0o700 });

    const base = await fs.realpath(this.sharedRoot);
    const parts = projectId === null ? [CHAT_ARTIFACT_RUNS] : [CHAT_ARTIFACT_RUNS, 'projects', projectId];
    const record = await makeRun(base, parts, id);
    const file = path.join(this.index, sha256(chatKey), id + '.json');

    await writeDurableFile(file, JSON.stringify(record));

    return {
      directory: path.join(record.base, id),
      finish: (now = Date.now()) => writeDurableFile(file, JSON.stringify({ ...record, finishedAt: now })),
    };
  }

  /**
   * Чат получает только папки собственных запусков с прежним inode.
   * Подменённые и исчезнувшие рабочие корни исключаются по одному.
   */
  async roots(chatKey: string) {
    const entries = await this.entries(sha256(chatKey));
    const roots: RunRoot[] = [];

    for (const { id, record } of entries) {
      const directory = path.join(record.base, id);
      const stat = await present(directory).catch(() => null);
      const canonical = stat ? await fs.realpath(directory).catch(() => null) : null;

      if (stat && hasIdentity(stat, record.identity) && canonical === directory) {
        roots.push({
          key: id,
          path: directory,
          label: path.basename(directory),
          fixed: true,
        });
      }
    }

    return roots;
  }

  /**
   * Только завершённые записи индекса допускаются к ротации. Без отметки
   * о завершении исход неизвестен, поэтому даже после рестарта каталог остаётся.
   */
  async sweep(now = Date.now(), signal?: AbortSignal) {
    const owners = await fs.readdir(this.index).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });
    let errors = 0;

    for (const owner of owners.filter((id) => OWNER_ID.test(id))) {
      for (const { id, file, record } of await this.entries(owner)) {
        signal?.throwIfAborted();

        if (record.finishedAt !== null && record.finishedAt <= now - CHAT_ARTIFACT_RETENTION_MS) {
          try {
            await this.expire(id, file, record, signal);
          } catch {
            errors++;
          }
        }
      }
    }

    return errors;
  }

  /**
   * Возраст берётся только из записей, которые создал сервер. Неполная
   * запись и неизвестное имя никогда не дают допуска к удалению.
   */
  private async entries(owner: string) {
    const directory = path.join(this.index, owner);
    const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });
    const entries: RunEntry[] = [];

    for (const name of names) {
      const id = name.slice(0, -5);

      if (!name.endsWith('.json') || !RUN_ID.test(id)) {
        continue;
      }

      const file = path.join(directory, name);
      const record = await fs.readFile(file, 'utf8')
        .then((text) => JSON.parse(text) as RunRecord)
        .catch(() => null);

      if (record && typeof record.base === 'string' && path.isAbsolute(record.base)
        && (record.finishedAt === null || Number.isSafeInteger(record.finishedAt))
        && [record.baseIdentity, record.identity].every((value) =>
          Number.isSafeInteger(value?.dev) && Number.isSafeInteger(value?.ino))) {
        entries.push({
          id,
          file,
          record,
        });
      }
    }

    return entries;
  }

  /**
   * Удаляется только зарегистрированное дерево, закреплённое за физическим
   * родителем. Локальная отметка .keep и занятый каталог откладывают удаление.
   */
  private async expire(id: string, file: string, record: RunRecord, signal?: AbortSignal) {
    const directory = path.join(record.base, id);
    const base = await present(record.base);

    if (!base || !hasIdentity(base, record.baseIdentity) || await fs.realpath(record.base) !== record.base) {
      return;
    }

    const stat = await present(directory);

    if (!stat) {
      await fs.rm(file, { force: true });

      return;
    }

    if (!hasIdentity(stat, record.identity) || await fs.realpath(directory) !== directory) {
      return;
    }

    const pinned = await openArtifactDirectory({
      root: record.base,
      directory,
      rootStat: base,
      stat,
      signal,
    });

    try {
      const lock = await acquireDirectoryLock(pinned.path + '.lock', { waitMs: 0, signal })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'directory_lock_busy') {
            return null;
          }

          throw error;
        });

      if (!lock) {
        return;
      }

      try {
        if (!await present(path.join(pinned.path, '.keep'))) {
          await pinned.remove();
          await fs.rm(file, { force: true });
        }
      } finally {
        await lock.release();
      }
    } finally {
      await pinned.close();
    }
  }
}
