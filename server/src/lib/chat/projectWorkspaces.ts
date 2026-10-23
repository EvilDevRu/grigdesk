import { promises as fs } from 'node:fs';
import path from 'node:path';

import { writeDurableFile } from '../durableFile.ts';
import type { ProjectRepoRef } from '../projects.ts';

interface Snapshot {
  revision: number;
  repos: ProjectRepoRef[];
  defaultRepoKey: string | null;
}

/**
 * Корни старых разговоров принадлежат истории, а не каталогу регистраций.
 * Снимок по проекту не требует чтения или переписывания отдельных разговоров.
 */
export class ChatProjectWorkspaces {
  private file: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(chatsDir: string) {
    this.file = path.join(chatsDir, 'project-workspaces.json');
  }

  /**
   * Чтение строгое: повреждённый снимок нельзя заменить пустым при удалении.
   * Отсутствие файла допустимо до первого удаления регистрации.
   */
  private async read(): Promise<{ version: 1; projects: Record<string, Snapshot> }> {
    let value;

    try {
      value = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, projects: {} };
      }

      throw error;
    }

    if (value?.version !== 1 || !value.projects || typeof value.projects !== 'object'
      || Array.isArray(value.projects)) {
      throw new Error('Повреждён снимок корней проектов.');
    }

    for (const row of Object.values(value.projects) as Snapshot[]) {
      if (!row || !Number.isSafeInteger(row.revision) || !Array.isArray(row.repos)
        || row.repos.some((repo) => typeof repo.key !== 'string' || typeof repo.dir !== 'string')
        || !(row.defaultRepoKey === null || typeof row.defaultRepoKey === 'string')) {
        throw new Error('Повреждён снимок корней проекта.');
      }
    }

    return value;
  }

  /**
   * Каждый снимок мержится со свежим файлом после предыдущей устойчивой записи.
   * Ошибка оставляет прежние снимки и допускает безопасный повтор операции.
   */
  capture(id: string, snapshot: Snapshot): Promise<void> {
    const operation = async () => {
      const value = await this.read();

      value.projects[id] = snapshot;
      await writeDurableFile(this.file, JSON.stringify(value));
    };
    const result = this.tail.then(operation, operation);

    this.tail = result.then(() => undefined, () => undefined);

    return result;
  }

  /**
   * Снимок разрешён только следующей ревизией удаления того же проекта.
   * Несовпадение не превращает старые корни в доступную регистрацию.
   */
  async retained(id: string, tombstoneRevision: number): Promise<Snapshot | null> {
    const row = (await this.read()).projects[id];

    return row && row.revision + 1 === tombstoneRevision ? row : null;
  }
}
