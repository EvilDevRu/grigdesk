import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { LEGACY, LEGACY_DATA_PATHS } from '../shared/runtime/legacyBrand.ts';
import {
  alive, assertPlainPath, atomicFile, bytesFingerprint, fingerprint, guardContext,
  lockHome, starttime, stat, syncDirectory,
} from './brandMoveFiles.ts';
import { BRAND_ACTIONS, brandHome, buildOperations, codeLinks } from './brandMovePlan.ts';
import type { BrandOperation, PendingOperation } from './brandMovePlan.ts';

export interface BrandContext {
  codeRoot: string;
  userHome: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface BrandCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface BrandReport {
  code: number;
  messages: string[];
}

export interface BrandPlan extends BrandReport {
  actions: string[];
  refusals: BrandCheck[];
  kept: string[];
}

export interface BrandDeps {
  fs: typeof import('node:fs');
  checkRuntime(context: BrandContext): Promise<BrandCheck[]>;
  checkpoint?: (name: string) => Promise<void>;
}

interface BrandJournal {
  version: 1;
  codeRoot: string;
  userHome: string;
  staged: boolean;
  completed: boolean;
  done: string[];
  operations: BrandOperation[];
  kept: string[];
}

interface Inspection {
  journal: BrandJournal | null;
  operations: PendingOperation[];
  kept: string[];
}

function journalPath(context: BrandContext): string {
  return path.join(brandHome(context), 'state/brand-move.json');
}

/**
 * Проверяет запись журнала до использования сохранённых путей.
 * Даже повреждённый журнал не может направить откат за пределы известных мест.
 */
function readJournal(context: BrandContext, deps: BrandDeps): BrandJournal | null {
  const file = journalPath(context);
  const { fs } = deps;

  assertPlainPath(brandHome(context), file, fs);

  if (!stat(file, fs)) {
    return null;
  }

  let value: BrandJournal;

  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8')) as BrandJournal;
  } catch {
    throw new Error(`Повреждён журнал: ${file}`);
  }

  if (value.version !== 1 || value.codeRoot !== context.codeRoot || value.userHome !== context.userHome
    || !Array.isArray(value.operations) || !Array.isArray(value.kept) || !Array.isArray(value.done)
    || typeof value.staged !== 'boolean' || typeof value.completed !== 'boolean') {
    throw new Error(`Журнал относится к другой раскладке или повреждён: ${file}`);
  }

  const home = brandHome(context);
  const backup = path.join(home, 'state/brand-move-backup');
  const configOld = path.join(context.userHome, '.config', LEGACY.configDir);
  const allowedWrite = (source: string) => [path.join(home, '.env'), path.join(home, 'state/prefs.json'),
    path.join(home, 'state/showcase-browser/browser.json')].includes(source)
    || (path.dirname(source) === path.join(home, 'state/sandboxes') && source.endsWith('.json'));

  for (const [index, op] of value.operations.entries()) {
    const id = String(index + 1).padStart(3, '0');
    const expectedBackup = path.join(backup, op.source === path.join(home, '.env') ? '.env' : `${id}.before`);
    const renameAllowed = LEGACY_DATA_PATHS.some(([source, target]) =>
      op.source === path.join(home, source) && op.target === path.join(home, target))
      || (op.source.startsWith(path.join(home, LEGACY_DATA_PATHS[0][0]) + '.')
        && path.dirname(op.source) === path.join(home, 'state')
        && op.target === op.source.replace(LEGACY_DATA_PATHS[0][0], LEGACY_DATA_PATHS[0][1]))
      || (op.source === configOld && op.target === path.join(context.userHome, '.config/grigdesk'));
    const linkAllowed = codeLinks(context).some(([source, relative]) => op.source === source
      && op.newLink === path.join(home, relative)
      && typeof op.oldLink === 'string'
      && path.resolve(path.dirname(source), op.oldLink)
        === path.join(context.userHome, LEGACY.dataHomeDir, relative));
    const kindAllowed = op.kind === 'rename' ? renameAllowed
      : op.source === op.target && (op.kind === 'write' ? allowedWrite(op.source)
        : op.kind === 'link' && linkAllowed);

    if (!kindAllowed || op.id !== id || op.backup !== expectedBackup || op.next !== `${op.backup}.after`
      || !/^[a-f0-9]{64}$/.test(op.before) || !/^[a-f0-9]{64}$/.test(op.after)
      || !Number.isInteger(op.mode) || op.mode < 0 || op.mode > 0o777) {
      throw new Error(`Повреждён список действий: ${file}`);
    }
  }

  return value;
}

/**
 * Проверяет шаг владельца и признаки занятости без каких-либо записей.
 * Замок текущего процесса тоже считается чужим до явного захвата этой командой.
 */
function checkFiles(context: BrandContext, deps: BrandDeps, locked: boolean): void {
  const { fs } = deps;
  const home = brandHome(context);
  const oldHome = path.join(context.userHome, LEGACY.dataHomeDir);

  assertPlainPath(context.userHome, home, fs);

  if (!stat(home, fs)?.isDirectory() || !stat(oldHome, fs)?.isSymbolicLink()
    || fs.realpathSync(oldHome) !== fs.realpathSync(home)) {
    throw new Error('Шаг 0 владельца не выполнен: нужна старая ссылка на новую папку данных.');
  }

  for (const relative of ['state', 'plugins', 'state/brand-move-backup']) {
    assertPlainPath(home, path.join(home, relative), fs);
  }

  if (!stat(path.join(home, 'state'), fs)?.isDirectory()) {
    throw new Error('Нет каталога состояния в новой папке данных.');
  }

  const config = context.env.XDG_CONFIG_HOME || path.join(context.userHome, '.config');
  const profiles = [path.join(config, LEGACY.profileDir), path.join(config, 'GrigDesk')];

  if (context.env.GRIGDESK_DESKTOP_DATA_DIR) {
    profiles.push(context.env.GRIGDESK_DESKTOP_DATA_DIR);
  }

  for (const profile of profiles) {
    const lock = path.join(profile, 'SingletonLock');

    if (stat(lock, fs)?.isSymbolicLink()) {
      const target = fs.readlinkSync(lock);
      const match = /^(.*)-(\d+)$/.exec(target);

      if (!match || match[1] !== os.hostname() || alive(Number(match[2]))) {
        throw new Error(`Профиль окна занят: ${lock}`);
      }
    } else if (stat(lock, fs)) {
      throw new Error(`Неизвестный замок профиля: ${lock}`);
    }
  }

  for (const relative of LEGACY_DATA_PATHS[2]) {
    const directory = path.join(home, relative, 'transactions');

    assertPlainPath(home, directory, fs);

    if (stat(directory, fs) && fs.readdirSync(directory).length) {
      throw new Error(`Незавершённая транзакция плагина: ${directory}`);
    }
  }

  const lock = path.join(home, 'state/server.lock');

  assertPlainPath(home, lock, fs);

  if (!locked && stat(lock, fs)) {
    let owner: { pid?: number; starttime?: string };

    try {
      owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    } catch {
      throw new Error(`Нечитаемый замок сервера: ${lock}`);
    }

    if (owner.pid && alive(owner.pid)) {
      const current = starttime(owner.pid, fs);

      if (current === null || current === owner.starttime) {
        throw new Error(`Папка данных занята: ${lock}`);
      }
    }
  }
}

/**
 * Все отказы проверяются до подготовки журнала, копий и взятия замка.
 * Продолжение использует исходный журнал, а не пересобирает план по половине переноса.
 */
async function inspect(context: BrandContext, deps: BrandDeps, locked = false): Promise<Inspection> {
  guardContext(context, deps.fs);
  checkFiles(context, deps, locked);

  const failures = (await deps.checkRuntime(context)).filter((check) => !check.ok);

  if (failures.length) {
    throw new Error(failures.map((check) => check.message).join('\n'));
  }

  const journal = readJournal(context, deps);

  if (journal) {
    for (const op of journal.operations) {
      assertOperationPaths(context, op, deps);
      operationState(op, deps);
    }

    return {
      journal,
      operations: journal.operations,
      kept: journal.kept,
    };
  }

  if (stat(path.join(brandHome(context), 'state/brand-move-backup'), deps.fs)) {
    throw new Error('Копии до изменений существуют без журнала: нужна ручная проверка.');
  }

  if (stat(path.join(context.userHome, '.config/grigdesk'), deps.fs)) {
    throw new Error('Цель уже существует: ~/.config/grigdesk');
  }

  return { journal: null, ...buildOperations(context, deps) };
}

/**
 * Отчёт содержит только имена файлов, ключей и причины отказа.
 * Исключения парсера данных предварительно заменены безопасными сообщениями по пути.
 */
function failure(error: unknown): BrandReport {
  return { code: 1, messages: [error instanceof Error ? error.message : 'Ошибка переноса.'] };
}

/**
 * План показывает все группы и оставленные ключи, сохраняя дерево неизменным.
 * Он не создаёт даже серверную блокировку или каталог для резервных копий.
 */
export async function planBrandMove(context: BrandContext, deps: BrandDeps): Promise<BrandPlan> {
  try {
    const inspection = await inspect(context, deps);

    return {
      code: 0,
      messages: ['План переноса готов.'],
      actions: [...BRAND_ACTIONS],
      refusals: [],
      kept: inspection.kept,
    };
  } catch (error) {
    const report = failure(error);

    return {
      ...report,
      actions: [],
      kept: [],
      refusals: [{
        id: 'preflight',
        ok: false,
        message: report.messages.join('\n'),
      }],
    };
  }
}

function saveJournal(context: BrandContext, journal: BrandJournal, deps: BrandDeps): void {
  atomicFile(journalPath(context), JSON.stringify(journal, null, 2) + '\n', 0o600, deps.fs);
}

/**
 * Готовит копии до первой мутации; секретные тексты не записываются в JSON-журнал.
 * Незавершённую подготовку можно повторить, проверяя уже сохранённые копии по отпечатку.
 */
function stage(context: BrandContext, inspection: Inspection, deps: BrandDeps): BrandJournal {
  const { fs } = deps;
  const journal: BrandJournal = inspection.journal ?? {
    version: 1,
    codeRoot: context.codeRoot,
    userHome: context.userHome,
    staged: false,
    completed: false,
    done: [],
    kept: inspection.kept,
    operations: inspection.operations.map(({ content, ...operation }) => operation),
  };

  if (journal.staged) {
    return journal;
  }

  if (!inspection.journal) {
    saveJournal(context, journal, deps);
  }

  const backup = path.join(brandHome(context), 'state/brand-move-backup');

  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });

  const planned = inspection.journal ? buildOperations(context, deps).operations : inspection.operations;

  for (const op of journal.operations) {
    if (fingerprint(op.source, fs) !== op.before) {
      throw new Error(`Файл изменился до подготовки копии: ${op.source}`);
    }

    if (!stat(op.backup, fs)) {
      if (op.kind === 'write') {
        atomicFile(op.backup, fs.readFileSync(op.source), 0o600, fs);
      } else {
        fs.cpSync(op.source, op.backup, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        });
      }
    }

    const backupHash = op.kind === 'write'
      ? bytesFingerprint(fs.readFileSync(op.backup), op.mode) : fingerprint(op.backup, fs);

    if (backupHash !== op.before) {
      throw new Error(`Копия до изменений повреждена: ${op.backup}`);
    }

    if (op.kind === 'write') {
      const content = planned.find((item) => item.id === op.id && item.source === op.source)?.content;

      if (content === undefined || bytesFingerprint(content, op.mode) !== op.after) {
        throw new Error(`Изменился план записи: ${op.source}`);
      }

      if (!stat(op.next, fs)) {
        atomicFile(op.next, content, 0o600, fs);
      }

      if (bytesFingerprint(fs.readFileSync(op.next), op.mode) !== op.after) {
        throw new Error(`Копия новых данных повреждена: ${op.next}`);
      }
    }
  }

  syncDirectory(backup, fs);
  journal.staged = true;
  saveJournal(context, journal, deps);

  return journal;
}

/**
 * Определяет, с какой стороны атомарного действия остановилась предыдущая попытка.
 * Третье состояние означает ручное изменение и запрещает продолжение или откат.
 */
function operationState(op: BrandOperation, deps: BrandDeps): 'before' | 'after' {
  const source = fingerprint(op.source, deps.fs);

  if (op.kind === 'rename') {
    const target = fingerprint(op.target, deps.fs);

    if (source === op.before && target === null) {
      return 'before';
    }

    if (source === null && target === op.after) {
      return 'after';
    }
  } else {
    if (source === op.before) {
      return 'before';
    }

    if (source === op.after) {
      return 'after';
    }
  }

  throw new Error(`Файл изменён после планирования; не перезаписываю: ${op.source}`);
}

/**
 * Повторяет границы путей и при продолжении, и при обратном ходе.
 * Подмена родительского каталога ссылкой не позволяет применить сохранённый план снаружи.
 */
function assertOperationPaths(context: BrandContext, op: BrandOperation, deps: BrandDeps): void {
  if (op.kind === 'link') {
    assertPlainPath(context.codeRoot, path.dirname(op.source), deps.fs);
  } else {
    assertPlainPath(context.userHome, op.source, deps.fs);
    assertPlainPath(context.userHome, op.target, deps.fs);
  }

  assertPlainPath(brandHome(context), path.dirname(op.backup), deps.fs);
}

/**
 * Замена ссылки тоже атомарна: после сбоя остаётся либо старый, либо новый адрес.
 * Содержимое её цели никогда не открывается и не копируется при этой операции.
 */
function replaceLink(file: string, target: string, deps: BrandDeps): void {
  const temp = `${file}.${randomUUID()}.tmp`;

  try {
    deps.fs.symlinkSync(target, temp);
    deps.fs.renameSync(temp, file);
    syncDirectory(path.dirname(file), deps.fs);
  } finally {
    if (stat(temp, deps.fs)) {
      deps.fs.unlinkSync(temp);
    }
  }
}

/**
 * Применяет или обращает одно атомарное действие после сверки отпечатков.
 * Перед восстановлением ещё раз проверяет копию, чтобы не потерять ручные данные.
 */
function perform(op: BrandOperation, deps: BrandDeps, reverse: boolean): void {
  const { fs } = deps;

  if (op.kind === 'rename') {
    fs.renameSync(reverse ? op.target : op.source, reverse ? op.source : op.target);
    syncDirectory(path.dirname(op.source), fs);
    syncDirectory(path.dirname(op.target), fs);
  } else if (op.kind === 'link') {
    replaceLink(op.source, reverse ? op.oldLink! : op.newLink!, deps);
  } else {
    const file = reverse ? op.backup : op.next;

    assertPlainPath(path.dirname(op.backup), file, fs);

    const bytes = fs.readFileSync(file);

    if (bytesFingerprint(bytes, op.mode) !== (reverse ? op.before : op.after)) {
      throw new Error(`Повреждена копия: ${file}`);
    }

    atomicFile(op.source, bytes, op.mode, fs);
  }
}

/**
 * Удалять каталог копий можно только при сохранности всех его ожидаемых файлов.
 * Ручная добавка или правка в копиях запрещает откат до первой обратной операции.
 */
function validateBackups(context: BrandContext, journal: BrandJournal, deps: BrandDeps): void {
  const directory = path.join(brandHome(context), 'state/brand-move-backup');
  const allowed = new Set(journal.operations.flatMap((op) =>
    [path.basename(op.backup), ...op.kind === 'write' ? [path.basename(op.next)] : []]));

  if (!stat(directory, deps.fs)) {
    if (journal.staged) {
      throw new Error(`Папка копий отсутствует: ${directory}`);
    }

    return;
  }

  for (const name of deps.fs.readdirSync(directory)) {
    if (!allowed.has(name)) {
      throw new Error(`Чужой файл в папке копий: ${path.join(directory, name)}`);
    }
  }

  for (const op of journal.operations) {
    for (const [file, expected] of [[op.backup, op.before],
      ...op.kind === 'write' ? [[op.next, op.after]] : []]) {
      if (!journal.staged && !stat(file!, deps.fs)) {
        continue;
      }

      const actual = op.kind === 'write'
        ? bytesFingerprint(deps.fs.readFileSync(file!), op.mode) : fingerprint(file!, deps.fs);

      if (actual !== expected) {
        throw new Error(`Повреждена копия: ${file}`);
      }
    }
  }
}

/**
 * Перенос берёт серверный замок и сохраняет план до первого изменения данных.
 * Завершённое действие распознаётся по отпечатку даже при сбое до записи журнала.
 */
export async function applyBrandMove(context: BrandContext, deps: BrandDeps): Promise<BrandReport> {
  let release: (() => void) | undefined;

  try {
    await inspect(context, deps);
    release = lockHome(context, deps.fs);

    const inspection = await inspect(context, deps, true);
    const journal = stage(context, inspection, deps);

    for (const op of journal.operations) {
      assertOperationPaths(context, op, deps);

      if (operationState(op, deps) === 'before') {
        perform(op, deps, false);
        await deps.checkpoint?.(op.id);
      }

      if (!journal.done.includes(op.id)) {
        journal.done.push(op.id);
        saveJournal(context, journal, deps);
      }
    }

    if (!journal.completed) {
      journal.completed = true;
      saveJournal(context, journal, deps);
    }

    return { code: 0, messages: ['Перенос завершён.', ...journal.kept] };
  } catch (error) {
    return failure(error);
  } finally {
    release?.();
  }
}

/**
 * Сначала проверяет все файлы, затем возвращает только ещё применённые действия.
 * Изменённый владельцем файл останавливает откат до первого обратного rename.
 */
export async function backBrandMove(context: BrandContext, deps: BrandDeps): Promise<BrandReport> {
  let release: (() => void) | undefined;

  try {
    const initial = await inspect(context, deps);

    if (!initial.journal) {
      return { code: 0, messages: ['Журнала переноса нет.'] };
    }

    release = lockHome(context, deps.fs);

    const { journal } = await inspect(context, deps, true);

    validateBackups(context, journal!, deps);

    for (const op of journal!.operations) {
      operationState(op, deps);
    }

    for (const op of [...journal!.operations].reverse()) {
      if (operationState(op, deps) === 'after') {
        perform(op, deps, true);
        await deps.checkpoint?.(`back:${op.id}`);
      }
    }

    deps.fs.rmSync(path.join(brandHome(context), 'state/brand-move-backup'),
      { recursive: true, force: true });
    deps.fs.unlinkSync(journalPath(context));
    syncDirectory(path.join(brandHome(context), 'state'), deps.fs);

    return { code: 0, messages: ['Исходная раскладка восстановлена.'] };
  } catch (error) {
    return failure(error);
  } finally {
    release?.();
  }
}

/**
 * Убирает только два принадлежащих приложению моста в дереве кода.
 * Настоящие файлы, чужие ссылки и бессрочная домашняя ссылка остаются на месте.
 */
export async function dropBrandLinks(context: BrandContext, deps: BrandDeps): Promise<BrandReport> {
  let release: (() => void) | undefined;

  try {
    guardContext(context, deps.fs);
    checkFiles(context, deps, false);

    const failures = (await deps.checkRuntime(context)).filter((check) => !check.ok);

    if (failures.length) {
      throw new Error(failures.map((check) => check.message).join('\n'));
    }

    release = lockHome(context, deps.fs);

    const messages: string[] = [];

    for (const [file, relative] of codeLinks(context)) {
      assertPlainPath(context.codeRoot, path.dirname(file), deps.fs);

      if (!stat(file, deps.fs)?.isSymbolicLink()) {
        continue;
      }

      const target = path.resolve(path.dirname(file), deps.fs.readlinkSync(file));
      const ours = [brandHome(context), path.join(context.userHome, LEGACY.dataHomeDir)]
        .some((root) => target === path.join(root, relative));

      if (ours) {
        deps.fs.unlinkSync(file);
        syncDirectory(path.dirname(file), deps.fs);
        messages.push(`Удалена ссылка: ${file}`);
      }
    }

    return { code: 0, messages };
  } catch (error) {
    return failure(error);
  } finally {
    release?.();
  }
}
