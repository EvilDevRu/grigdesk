import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { acquireDirectoryLock } from '../../../../shared/node/directoryLock.ts';
import { decodeOnboardingDocument, OnboardingError } from '../../../../shared/runtime/onboardingContracts.ts';
import type { OnboardingDocument } from '../../../../shared/runtime/onboardingContracts.ts';

export class OnboardingStore {
  file: string;

  constructor(directory: string) {
    this.file = path.join(directory, 'onboarding.json');
  }

  /**
   * Только ENOENT означает новую установку; остальные ошибки остаются явными.
   * Чтение ничего не создаёт и не исправляет повреждённый файл.
   */
  async read(): Promise<OnboardingDocument> {
    try {
      return decodeOnboardingDocument(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          schemaVersion: 1,
          revision: 0,
          autoOpenDisabled: false,
          active: null,
          answersByProject: {},
        };
      }

      throw new OnboardingError('read_failed', 500);
    }
  }

  /**
   * Lock объединяет свежую проверку ревизии и все фазы создания проекта.
   * Каждая публикация атомарна, ACK и события допустимы только после rename.
   */
  async transact(
    expected: number,
    action: (state: OnboardingDocument, save: () => Promise<void>) => Promise<void>,
  ): Promise<OnboardingDocument> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });

    const lock = await acquireDirectoryLock(`${this.file}.lock`);

    try {
      const state = await this.read();

      if (state.revision !== expected) {
        throw new OnboardingError('revision_conflict', 409);
      }

      await action(state, async () => {
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        const next = { ...state, revision: state.revision + 1 };

        try {
          await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, this.file);
          state.revision = next.revision;
        } finally {
          await fs.rm(temporary, { force: true });
        }
      });

      return state;
    } finally {
      await lock.release();
    }
  }
}
