import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import type { InstallRoots } from './npmEnvironment.ts';

/**
 * Узкая миграция одной доказанной bin-ссылки: npm создаёт свою ссылку в том же
 * месте, поэтому старая ссылка на D-пакет временно резервируется. Это не откат
 * всего npm — объекты живут в приватном state рядом с job.
 */
export interface BinIdentity {
  dev: number;
  ino: number;
}

export interface BinTargetInspection {
  status: 'free' | 'mine' | 'legacy' | 'conflict';
  target: string;
  reason: string | null;
  realpath: string | null;
  link: string | null;
  identity: BinIdentity | null;
  packageName: string | null;
}

export interface MigrationJournal {
  jobId: string;
  target: string;
  backup: string;
  packageId: string;
  binName: string;
  configKey: string;
  oldBin: string;
  originalLink: string;
  originalRealpath: string;
  identity: BinIdentity;
  phase: 'planned' | 'backed-up' | 'replaced' | 'committed';
  replacement: (BinIdentity & { realpath: string }) | null;
}

const inside = (target: string, root: string): boolean => {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);

  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
};

const statIdentity = async (file: string): Promise<BinIdentity | null> => {
  const stat = await fs.lstat(file).catch(() => null);

  return stat ? { dev: stat.dev, ino: stat.ino } : null;
};

const sameIdentity = (left: BinIdentity | null, right: BinIdentity | null): boolean =>
  Boolean(left && right && left.dev === right.dev && left.ino === right.ino);

/**
 * Пакет доказывается именем из package.json вверх по realpath: одного пути
 * с подстрокой `.grigdesk` или совпадения имени файла недостаточно.
 */
async function packageRootOf(realpath: string, packageId: string): Promise<string | null> {
  let current = path.dirname(realpath);

  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = await fs.readFile(path.join(current, 'package.json'), 'utf8')
      .then((text) => JSON.parse(text) as { name?: unknown }, () => null);

    if (manifest && manifest.name === packageId) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

/**
 * Классификация цели установки: свободно, наша прежняя npm-копия, доказуемая
 * legacy-ссылка на выбранный D-пакет или чужой объект. Чужой объект никогда
 * не затеняется установкой молча.
 */
export async function inspectBinTarget(input: {
  target: string;
  prefix: string;
  roots: InstallRoots;
  packageId: string;
  binName: string;
  oldBin: string | null;
}): Promise<BinTargetInspection> {
  const base: BinTargetInspection = {
    status: 'free',
    target: input.target,
    reason: null,
    realpath: null,
    link: null,
    identity: null,
    packageName: null,
  };
  const held = await fs.lstat(input.target).catch(() => null);

  if (!held) {
    return base;
  }

  const identity = { dev: held.dev, ino: held.ino };

  if (!held.isSymbolicLink()) {
    return {
      ...base,
      status: 'conflict',
      reason: 'npm_bin_conflict',
      identity,
    };
  }

  const link = await fs.readlink(input.target).catch(() => null);
  const realpath = await fs.realpath(input.target).catch(() => null);

  if (!realpath) {
    return {
      ...base,
      status: 'conflict',
      reason: 'npm_bin_conflict',
      identity,
      link,
    };
  }

  const packageRoot = await packageRootOf(realpath, input.packageId);
  const manifestName = packageRoot ? input.packageId : null;
  const ownRoot = path.join(input.prefix, 'lib', 'node_modules');
  const dataRoot = path.join(input.roots.dataHome, 'state', 'npm-global', 'lib', 'node_modules');

  if (packageRoot && inside(packageRoot, ownRoot)) {
    return {
      ...base,
      status: 'mine',
      realpath,
      link,
      identity,
      packageName: manifestName,
    };
  }
  if (packageRoot && inside(packageRoot, dataRoot)) {
    return {
      ...base,
      status: 'legacy',
      realpath,
      link,
      identity,
      packageName: manifestName,
    };
  }

  return {
    ...base,
    status: 'conflict',
    reason: 'npm_bin_conflict',
    realpath,
    link,
    identity,
    packageName: manifestName,
  };
}

/**
 * Совпадающая цель npm в `HOME/.local/bin` не даёт установить пакет до проверки
 * новой копии, поэтому ссылка переносится в соседнее имя и возвращается при отказе.
 * Журнал создаётся заранее: восстановление возможно и после перезапуска сервера.
 */
export function createMigrationJournal(input: {
  jobId: string;
  target: string;
  inspection: BinTargetInspection;
  packageId: string;
  binName: string;
  configKey: string;
  oldBin: string;
}): MigrationJournal | null {
  if (input.inspection.status !== 'legacy' || !input.inspection.realpath
    || !input.inspection.identity || input.inspection.link === null) {
    return null;
  }

  return {
    jobId: input.jobId,
    target: input.target,
    backup: path.join(path.dirname(input.target),
      `.${input.binName}.grigdesk-backup-${randomBytes(6).toString('hex')}`),
    packageId: input.packageId,
    binName: input.binName,
    configKey: input.configKey,
    oldBin: input.oldBin,
    originalLink: input.inspection.link,
    originalRealpath: input.inspection.realpath,
    identity: input.inspection.identity,
    phase: 'planned',
    replacement: null,
  };
}

/**
 * Журнал читается обратно из приватного состояния после перезапуска.
 * Неверная форма запрещает новые установки, а не угадывается.
 */
export function isMigrationJournal(value: unknown): value is MigrationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const journal = value as Record<string, unknown>;
  const identity = (field: unknown): boolean => Boolean(field) && typeof field === 'object'
    && Number.isInteger((field as BinIdentity).dev) && Number.isInteger((field as BinIdentity).ino);

  return ['jobId', 'target', 'backup', 'packageId', 'binName', 'configKey', 'oldBin',
    'originalLink', 'originalRealpath'].every((key) => typeof journal[key] === 'string')
    && ['planned', 'backed-up', 'replaced', 'committed'].includes(String(journal.phase))
    && identity(journal.identity)
    && (journal.replacement === null
      || (identity(journal.replacement)
        && typeof (journal.replacement as { realpath?: unknown }).realpath === 'string'));
}

export class MigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

/**
 * Перенос ссылки делается только после повторной сверки снимка: если объект
 * изменился между подготовкой и действием, миграция не начинается.
 */
export async function backupLegacyLink(journal: MigrationJournal): Promise<MigrationJournal> {
  const held = await fs.lstat(journal.target).catch(() => null);
  const link = await fs.readlink(journal.target).catch(() => null);
  const identity = held ? { dev: held.dev, ino: held.ino } : null;

  if (!held?.isSymbolicLink() || !sameIdentity(identity, journal.identity)
    || link !== journal.originalLink) {
    throw new MigrationError('migration_recovery_required',
      'Старая bin-ссылка изменилась до миграции');
  }

  await fs.rename(journal.target, journal.backup);

  const moved = await fs.lstat(journal.backup).catch(() => null);

  if (!moved || !sameIdentity({ dev: moved.dev, ino: moved.ino }, journal.identity)) {
    throw new MigrationError('migration_recovery_required',
      'Перенесённая bin-ссылка не совпала по identity');
  }

  return { ...journal, phase: 'backed-up' };
}

/**
 * До commit старый путь возвращается только если имя свободно или занято
 * доказанной заменой этой операции. Неизвестный объект сохраняется вместе
 * с резервной копией: новые установки блокируются, чужие файлы не удаляются.
 */
export async function restoreLegacyLink(journal: MigrationJournal):
  Promise<'restored' | 'blocked'> {
  const atBackup = await fs.lstat(journal.backup).catch(() => null);

  if (!atBackup || !sameIdentity({ dev: atBackup.dev, ino: atBackup.ino }, journal.identity)) {
    return 'blocked';
  }

  const current = await fs.lstat(journal.target).catch(() => null);

  if (current) {
    const replaced = journal.replacement
      && sameIdentity({ dev: current.dev, ino: current.ino }, journal.replacement);

    if (!replaced) {
      return 'blocked';
    }

    await fs.unlink(journal.target);
  }

  try {
    await fs.symlink(journal.originalLink, journal.target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'blocked';
    }

    throw error;
  }

  await fs.unlink(journal.backup).catch(() => {});

  return 'restored';
}

/**
 * После подтверждённого `.env` резервная копия больше не нужна: старая D-копия
 * остаётся, но ссылка на неё из пользовательского bin не восстанавливается.
 */
export async function completeMigration(journal: MigrationJournal): Promise<void> {
  await fs.rm(journal.backup, { force: true }).catch(() => {});
}

/**
 * Доказанная замена — существующая ссылка ведёт в пакет нового prefix.
 * Только такая цель позволяет вернуть старую ссылку после отказа npm.
 */
export async function inspectReplacement(journal: MigrationJournal): Promise<MigrationJournal> {
  const held = await fs.lstat(journal.target).catch(() => null);
  const realpath = await fs.realpath(journal.target).catch(() => null);

  if (!held || !held.isSymbolicLink() || !realpath
    || !inside(realpath, path.join(path.dirname(path.dirname(journal.target)), 'lib', 'node_modules'))) {
    return journal;
  }

  return {
    ...journal,
    phase: 'replaced',
    replacement: {
      dev: held.dev,
      ino: held.ino,
      realpath,
    },
  };
}
