import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { acquireDirectoryLock } from '../../../../shared/node/directoryLock.ts';
import { decodeGrigdeskTask } from '../../../../shared/tasks/grigdeskTaskContracts.ts';
import type { GrigdeskTask } from '../../../../shared/tasks/grigdeskTaskContracts.ts';
import {
  FIRST_TASK_NUMBER, LAST_TASK_NUMBER, GrigdeskTaskStoreError, reserveTaskNumber,
} from './numbers.ts';
import type { GrigdeskTasksConfig, TaskNumberProbe } from './numbers.ts';

export { GrigdeskTaskStoreError } from './numbers.ts';

interface TaskDocument {
  schemaVersion: 1;
  revision: number;
  nextId: string;
  tasks: GrigdeskTask[];
}

type TaskDraft = Omit<GrigdeskTask, 'id' | 'source' | 'createdAt' | 'sourceUrl'> & { clientOrigin: string };

/**
 * Только отсутствие файла означает новое хранилище.
 * Повреждение или ошибка доступа остаются отказом и никогда не затираются пустым списком.
 */
async function readDocument(config: GrigdeskTasksConfig): Promise<TaskDocument> {
  const empty: TaskDocument = {
    schemaVersion: 1,
    revision: 0,
    nextId: String(FIRST_TASK_NUMBER),
    tasks: [],
  };

  if (!config.grigdeskTasksPath) {
    return empty;
  }

  try {
    const value = JSON.parse(await fs.readFile(config.grigdeskTasksPath, 'utf8')) as TaskDocument;

    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.nextId !== 'string' || !/^\d+$/.test(value.nextId)
      || Number(value.nextId) < FIRST_TASK_NUMBER || Number(value.nextId) > LAST_TASK_NUMBER + 1
      || !Array.isArray(value.tasks)) {
      throw new Error('Некорректный документ задач');
    }

    const tasks = value.tasks.map((task) => decodeGrigdeskTask(task));

    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
      throw new Error('Повтор номера задачи');
    }

    return { ...value, tasks };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return empty;
    }

    throw new GrigdeskTaskStoreError();
  }
}

/**
 * Общий читатель не создаёт каталогов и доступен оценке и фабрике без сборки app.
 * Старые конфигурации без пути сохраняют прежнюю ветку Б24.
 */
export async function readGrigdeskTask(
  config: GrigdeskTasksConfig,
  id: string | number,
): Promise<GrigdeskTask | null> {
  return (await readDocument(config)).tasks.find((task) => task.id === String(id)) || null;
}

export class GrigdeskTaskStore {
  config: GrigdeskTasksConfig;
  b24?: TaskNumberProbe;

  constructor({ config, b24 }: { config: GrigdeskTasksConfig; b24?: TaskNumberProbe }) {
    this.config = config;
    this.b24 = b24;
  }

  async list() {
    const { tasks, revision } = await readDocument(this.config);

    return { tasks, revision };
  }

  get(id: string | number) {
    return readGrigdeskTask(this.config, id);
  }

  /**
   * Межпроцессный lock охватывает чтение, резерв и атомарную публикацию документа.
   * Ответ создания появляется только после rename, а не после захвата номера.
   */
  async create(draft: TaskDraft): Promise<{ task: GrigdeskTask; revision: number }> {
    const target = this.config.grigdeskTasksPath;

    if (!target) {
      throw new GrigdeskTaskStoreError();
    }

    let lock;
    const temporary = `${target}.${randomUUID()}.tmp`;

    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      lock = await acquireDirectoryLock(`${target}.lock`);

      const document = await readDocument(this.config);
      const id = await reserveTaskNumber(
        this.config, document.nextId, document.tasks.map((task) => task.id), this.b24,
      );
      const { clientOrigin, ...fields } = draft;
      const task: GrigdeskTask = {
        ...fields,
        id,
        source: 'grigdesk',
        sourceUrl: `${clientOrigin}/#/board?openTask=${id}`,
        createdAt: new Date().toISOString(),
      };
      const revision = document.revision + 1;

      await fs.writeFile(temporary, JSON.stringify({
        schemaVersion: 1,
        revision,
        nextId: String(Number(id) + 1),
        tasks: [...document.tasks, task],
      }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, target);

      return { task, revision };
    } catch (error) {
      if (error instanceof GrigdeskTaskStoreError) {
        throw error;
      }

      throw new GrigdeskTaskStoreError();
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
      await lock?.release();
    }
  }
}
