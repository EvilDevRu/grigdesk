import fs from 'node:fs/promises';
import path from 'node:path';

export interface GrigdeskTasksConfig {
  grigdeskTasksPath?: string;
  stateDir?: string;
  analysisDir?: string;
  ticketsDir?: string;
  sandboxJournalDir?: string;
  factoryControlDir?: string;
  artifactsDir?: string;
  sandboxManualRange?: { from: number; to: number };
}

export interface TaskNumberProbe {
  isConfigured(): boolean;
  probeTaskNumber(id: string): Promise<'exists' | 'absent' | 'unknown'>;
}

export const FIRST_TASK_NUMBER = 100000000000;
export const LAST_TASK_NUMBER = 999999999999;

export class GrigdeskTaskStoreError extends Error {
  code: string;

  constructor(code = 'grigdesk_tasks_unavailable', message = 'Задачи GrigDesk временно недоступны') {
    super(message);
    this.code = code;
  }
}

/**
 * Читаются только технические имена в явно разрешённых корнях.
 * Недоступный каталог не считается пустым: безопасную выдачу номера нужно повторить позже.
 */
async function occupiedNumbers(config: GrigdeskTasksConfig): Promise<Set<string>> {
  const roots = [
    config.stateDir,
    config.stateDir && path.join(config.stateDir, 'archive'),
    config.analysisDir,
    config.ticketsDir,
    config.sandboxJournalDir,
    config.stateDir && path.join(config.stateDir, 'slots'),
    config.factoryControlDir && path.join(config.factoryControlDir, 'protocol-v2', 'tasks'),
    config.artifactsDir,
  ];
  const occupied = new Set<string>();

  for (const root of roots) {
    if (!root) {
      continue;
    }

    let names: string[];

    try {
      names = await fs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    for (const name of names) {
      const match = name.match(/^t([1-9]\d*)(?=\D|$)/)
        || (root === config.artifactsDir ? name.match(/-([1-9]\d*)(?=\D|$)/) : null);

      if (match?.[1]) {
        occupied.add(match[1]);
      }
    }
  }

  return occupied;
}

/**
 * Общий lock вызывающего store защищает выбор, а wx согласует его с ручным протоколом.
 * После отказа записи резерв остаётся занятым, чтобы уже выданный номер не ожил повторно.
 */
export async function reserveTaskNumber(
  config: GrigdeskTasksConfig,
  nextId: string,
  taskIds: string[],
  tracker?: TaskNumberProbe,
): Promise<string> {
  const occupied = await occupiedNumbers(config);

  for (const id of taskIds) {
    occupied.add(id);
  }

  if (!config.analysisDir) {
    throw new GrigdeskTaskStoreError();
  }

  await fs.mkdir(config.analysisDir, { recursive: true });

  for (let candidate = Math.max(FIRST_TASK_NUMBER, Number(nextId)), count = 0;
    candidate <= LAST_TASK_NUMBER && count < 10000; candidate += 1, count += 1) {
    const id = String(candidate);
    const range = config.sandboxManualRange;

    if (occupied.has(id) || (range && candidate >= range.from && candidate <= range.to)) {
      continue;
    }

    if (tracker?.isConfigured()) {
      const presence = await tracker.probeTaskNumber(id).catch(() => 'unknown');

      if (presence === 'exists') {
        continue;
      }

      if (presence !== 'absent') {
        throw new GrigdeskTaskStoreError('task_number_unverified', 'Не удалось проверить номер в Б24');
      }
    }

    try {
      await fs.writeFile(path.join(config.analysisDir, `t${id}.status.json`), 'null\n', {
        flag: 'wx',
        mode: 0o600,
      });

      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  throw new GrigdeskTaskStoreError('task_numbers_exhausted', 'Нет свободного номера задачи');
}
