// Межпроцессная аренда ручной песочницы для Showcase, действий профиля и lifecycle.
//
// Операции показа и действия профиля берут shared flock, а up/down — exclusive: пока
// на стенде идёт прогон, снести его нельзя, а два прогона друг другу не мешают.
// Замок относится к номеру задачи и живёт на отдельном inode в stateDir:
// `orch.lock` принадлежит другому протоколу и здесь намеренно не используется.
import path from 'node:path';

import { SANDBOX_TASK_RE } from '../../../../shared/sandboxContracts.ts';
import { acquireKernelFileLock } from '../kernelLock.ts';
import type { KernelFileLock } from '../kernelLock.ts';

export type SandboxActivityMode = 'shared' | 'exclusive';

export interface SandboxActivityLease extends KernelFileLock {
  mode: SandboxActivityMode;
  task: string;
}

export interface SandboxActivityGuard {
  acquireLifecycle: (task: string) => Promise<SandboxActivityLease>;
  acquireShowcase: (task: string) => Promise<SandboxActivityLease>;
  acquireAction: (task: string) => Promise<SandboxActivityLease>;
}

export interface SandboxActivityGuardOptions {
  stateDir: string;
  timeoutMs?: number;
  binary?: string;
}

export class SandboxActivityError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SandboxActivityError';
    this.code = code;
  }
}

/** Создаёт stateless guard: взаимное исключение обеспечивает kernel, не память сервера. */
export function createSandboxActivityGuard({
  stateDir,
  timeoutMs = 1,
  binary,
}: SandboxActivityGuardOptions): SandboxActivityGuard {
  const directory = path.join(stateDir, '.sandbox-activity');

  /** Берёт замок нужного режима и добавляет проверяемую привязку к task. */
  async function acquire(
    task: string,
    mode: SandboxActivityMode,
  ): Promise<SandboxActivityLease> {
    if (!SANDBOX_TASK_RE.test(task)) {
      throw new SandboxActivityError(
        'SANDBOX_ACTIVITY_INVALID_TASK',
        'Нельзя взять аренду песочницы с недопустимым номером.',
      );
    }

    const held = await acquireKernelFileLock({
      lockPath: path.join(directory, `t${task}.lock`),
      mode,
      timeoutMs,
      binary,
      timeoutCode: 'SANDBOX_ACTIVITY_BUSY',
      unavailableCode: 'SANDBOX_ACTIVITY_UNAVAILABLE',
      lostCode: 'SANDBOX_ACTIVITY_LOST',
      label: `песочницы ${task}`,
      errorFactory: (code, message) => new SandboxActivityError(code, message),
    });

    return Object.freeze({
      ...held,
      mode,
      task,
    });
  }

  return Object.freeze({
    acquireLifecycle: (task: string) => acquire(task, 'exclusive'),
    acquireShowcase: (task: string) => acquire(task, 'shared'),
    acquireAction: (task: string) => acquire(task, 'shared'),
  });
}
