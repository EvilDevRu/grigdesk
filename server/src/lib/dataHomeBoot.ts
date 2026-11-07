// Ранний старт синхронен: окружение готово до вычисления соседнего импорта config.
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { dataHome, dataHomeExplicit, dataPath, envFilePath } from '../../../shared/runtime/dataHome.ts';
import {
  LEGACY, LEGACY_DATA_PATHS, legacyEnvWarnings, legacyRootProblem,
} from '../../../shared/runtime/legacyBrand.ts';

export type BootFs = typeof nodeFs;

export class DataHomeError extends Error {}

export interface CheckInput {
  codeRoot: string;
  home: string;
  env: NodeJS.ProcessEnv
}
export interface LockOwner {
  pid: number;
  starttime: string;
  root: string;
  startedAt: string
}
export interface LockDeps {
  fs: BootFs;
  alive: (pid: number) => boolean;
  starttime: (pid: number) => string | null;
  now: () => number;
  sleep: (ms: number) => void;
  waitMs: number;
}
export interface PrepareDeps extends LockDeps { owner: LockOwner }

// Журнал старой сборки окна в server/.state — след запуска, а не данные: старая сборка без
// ключа GRIGDESK_LOG пишет его туда и после уборки ссылок, сервер из-за этого не встаёт.
const LEGACY_DIRS: Readonly<Record<string, ReadonlyArray<string | RegExp>>> = {
  'server/.state': [/^grigdesk-server\.log/],
  '.state/plugins': [],
  '.state/ui-releases': [],
  '.state/mobile': [],
  chats: ['.gitignore'],
  telegram: ['.gitignore'],
  github: ['.gitignore'],
  '3d': ['.gitignore'],
  agents: ['.gitignore'],
  plugins: ['README.md'],
};

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// Отсутствие записи штатно; ошибки доступа не превращаются в пустую раскладку.
// Ошибки файловой системы не должны приводить к запуску второго владельца.
function stat(file: string, fs: BootFs): nodeFs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (missing(error)) {
      return null;
    }

    throw error;
  }
}

// Канонизируем существующих предков, не создавая ещё отсутствующую папку.
// Ссылка в существующем предке учитывается и для ещё не созданного потомка.
function canonical(file: string, fs: BootFs): string {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (!missing(error) || path.dirname(file) === file || stat(file, fs)?.isSymbolicLink()) {
      throw error;
    }

    return path.join(canonical(path.dirname(file), fs), path.basename(file));
  }
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

// Проверяем реальные границы и при явной папке: это защита от выбора кода или HOME.
// Проверка выполняется до любой записи и работает также для ссылок.
function checkPlacement(selected: string, input: CheckInput, fs: BootFs): void {
  const target = canonical(selected, fs);
  const code = canonical(path.resolve(input.codeRoot), fs);
  const home = canonical(path.resolve(input.home), fs);

  if (target === home || contains(code, target) || contains(target, code)) {
    throw new DataHomeError('Папка данных не должна совпадать с HOME, лежать внутри кода или содержать его.');
  }
}

// В старой раскладке смотрим только вид записи и имена верхнего уровня, без чтения данных.
// Совместимые ссылки и единственная отслеживаемая заглушка не считаются данными.
export function findLegacyData(codeRoot: string, fs: BootFs): string[] {
  const found: string[] = [];
  const env = path.join(codeRoot, '.env');

  if (stat(env, fs)?.isFile()) {
    found.push(env);
  }

  for (const [relative, ignored] of Object.entries(LEGACY_DIRS)) {
    const directory = path.join(codeRoot, relative);

    if (stat(directory, fs)?.isDirectory() && fs.readdirSync(directory).some((name) => !ignored
      .some((rule) => typeof rule === 'string' ? rule === name : rule.test(name)))) {
      found.push(directory);
    }
  }

  return found;
}

function migrationError(reason: string): DataHomeError {
  return new DataHomeError(`${reason}\nПеренесите данные вручную в выбранную папку GrigDesk.\n`
    + 'Для второй копии репозитория задайте свою GRIGDESK_HOME.');
}

/**
 * Старый каталог не превращается в пустую новую установку, а две базы не смешиваются.
 * Даже явно выбранная папка требует переноса внутренних имён до первых записей сервера.
 */
function checkBrandDataHome(selected: string, input: CheckInput, fs: BootFs): void {
  if (!dataHomeExplicit(input)) {
    const old = path.join(input.home, LEGACY.dataHomeDir);
    const info = stat(old, fs);

    if (info?.isSymbolicLink()) {
      if (canonical(old, fs) !== canonical(selected, fs)) {
        throw new DataHomeError(`Ссылка ~/${LEGACY.dataHomeDir} должна вести в ~/.grigdesk.`);
      }
    } else if (info) {
      if (stat(selected, fs)) {
        throw new DataHomeError('Найдены две папки данных; выберите одну перед запуском.');
      }

      throw new DataHomeError('Найдена прежняя папка данных. Закройте приложение и выполните '
        + `mv -T ~/${LEGACY.dataHomeDir} ~/.grigdesk && ln -s .grigdesk ~/${LEGACY.dataHomeDir}.`);
    }
  }

  for (const [oldPath] of LEGACY_DATA_PATHS) {
    if (stat(path.join(selected, oldPath), fs)) {
      throw new DataHomeError('В папке данных остались прежние внутренние имена: '
        + 'запустите node tools/brandMove.mts --apply.');
    }
  }
}

// Та же проверка доступна запускалкам без создания папок, чтения .env или захвата блокировки.
// Явный независимый каталог позволяет запустить вторую копию репозитория.
export function checkDataHome(input: CheckInput, fs: BootFs): string {
  try {
    const problem = legacyRootProblem(input.env);

    if (problem) {
      throw new DataHomeError(problem);
    }

    const selected = dataHome(input);

    checkPlacement(selected, input, fs);
    checkBrandDataHome(selected, input, fs);

    if (dataHomeExplicit(input)) {
      return selected;
    }

    // Вторая копия репозитория (git worktree: .git — файл) без своей папки взяла бы настоящие
    // данные владельца — чаты, токен Telegram, ключи Б24 — пока основной сервер остановлен.
    if (stat(path.join(input.codeRoot, '.git'), fs)?.isFile()) {
      throw new DataHomeError('Это вторая копия репозитория (git worktree): задайте ей свою GRIGDESK_HOME.');
    }

    for (const [source, target] of [['.env', 'env'], ['server/.state', 'state']] as const) {
      const link = path.join(input.codeRoot, source);

      if (!stat(link, fs)?.isSymbolicLink()) {
        continue;
      }

      const expected = canonical(dataPath(selected, target), fs);
      let actual: string;

      try {
        actual = fs.realpathSync(link);
      } catch (error) {
        if (!missing(error)) {
          throw error;
        }

        throw migrationError(`Ссылка ${link} ведёт в несуществующее место: ${fs.readlinkSync(link)}.`);
      }

      if (actual !== expected) {
        throw migrationError(`Данные в ${actual}: задайте GRIGDESK_HOME или верните ссылку ${link}.`);
      }
    }

    const journal = dataPath(selected, 'moveJournal');
    let completed = false;

    if (stat(journal, fs)) {
      try {
        completed = JSON.parse(fs.readFileSync(journal, 'utf8')).completed === true;
      } catch {}

      if (!completed) {
        throw migrationError('Перенос не закончен.');
      }
    }

    const legacy = findLegacyData(input.codeRoot, fs);

    // После завершённого переноса --apply повторно ничего не берёт: совет вёл бы по кругу.
    if (legacy.length && completed) {
      throw new DataHomeError(`Перенос уже завершён, но в коде снова есть данные: ${legacy.join(', ')}.\n`
        + `Перенесите их вручную в ${selected} или удалите.`);
    }

    if (legacy.length) {
      throw migrationError(`Найдена старая раскладка: ${legacy.join(', ')}.`);
    }

    return canonical(selected, fs);
  } catch (error) {
    if (error instanceof DataHomeError) {
      throw error;
    }

    throw new DataHomeError((error as Error).message);
  }
}

// Присутствующее значение процесса, в том числе пустая строка, сильнее файла.
// Сначала отвергаем переназначение корней, затем переносим разрешённые имена.
export function loadDataHomeEnv(file: string, env: NodeJS.ProcessEnv, fs: BootFs): string[] {
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (missing(error)) {
      for (const warning of legacyEnvWarnings(env)) {
        process.stderr.write(`${warning}\n`);
      }

      return [];
    }

    throw new DataHomeError(`Не удалось прочитать файл настроек ${file}: ${(error as Error).message}`);
  }

  const parsed = parseEnv(text);

  const problem = legacyRootProblem(parsed, true);

  if (problem) {
    throw new DataHomeError(problem);
  }

  const added: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (Object.hasOwn(env, key)) {
      continue;
    }

    env[key] = value;
    added.push(key);
  }

  for (const warning of legacyEnvWarnings(env)) {
    process.stderr.write(`${warning}\n`);
  }

  return added;
}

// Мусор или недоступный файл рассматривается как запись для осторожного перехвата.
// Перехват потом сверяет переименованный файл, поэтому ошибочное чтение не отдаёт чужой lock.
function readLock(file: string, fs: BootFs): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Проверка формы не позволяет использовать произвольное содержимое в проверке PID.
// Неверная запись считается мёртвой и снимается через перехват, а не молча игнорируется.
function parseLock(bytes: string | null): LockOwner | null {
  try {
    const value = JSON.parse(bytes || 'null') as LockOwner | null;

    return value && Number.isInteger(value.pid) && value.pid > 0 && typeof value.starttime === 'string'
      && typeof value.root === 'string' ? value : null;
  } catch {
    return null;
  }
}

function sameOwner(left: LockOwner | null, right: LockOwner): boolean {
  return left?.pid === right.pid && left.starttime === right.starttime;
}

function liveOwner(record: LockOwner | null, owner: LockOwner, deps: LockDeps): boolean {
  if (!record || record.pid === owner.pid || !deps.alive(record.pid)) {
    return false;
  }

  const current = deps.starttime(record.pid);

  return current === null || current === record.starttime;
}

// После rename сверяем снимок: свежую чужую блокировку возвращаем только create-only link.
// Несовпадение останавливает старт, сохраняя чужую запись для её владельца.
function retireLock(file: string, bytes: string | null, owner: LockOwner, fs: BootFs): void {
  const stale = `${file}.stale-${owner.pid}-${randomBytes(8).toString('hex')}`;

  try {
    fs.renameSync(file, stale);
  } catch (error) {
    if (missing(error)) {
      return;
    }

    throw error;
  }

  if (readLock(stale, fs) !== bytes) {
    try {
      fs.linkSync(stale, file);
      fs.unlinkSync(stale);
    } catch {
      // При занятом имени сохраняем чужую запись под stale, не заменяем новый lock.
    }

    throw new DataHomeError('Блокировка изменилась во время захвата; повторите запуск.');
  }

  fs.unlinkSync(stale);
}

// Содержимое публикуется целиком атомарным link; проигравший ожидает именно владельца PID.
// При живом владельце опрашивается процесс до срока; срок и сон подменяются тестом.
export function acquireDataHomeLock(file: string, owner: LockOwner, deps: LockDeps): void {
  const { fs } = deps;
  const temp = `${file}.tmp-${owner.pid}-${randomBytes(8).toString('hex')}`;
  const deadline = deps.now() + deps.waitMs;
  const fd = fs.openSync(temp, 'wx', 0o600);

  try {
    fs.writeFileSync(fd, JSON.stringify(owner) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    for (;;) {
      try {
        fs.linkSync(temp, file);

        if (!sameOwner(parseLock(readLock(file, fs)), owner)) {
          throw new DataHomeError('Блокировка перехвачена.');
        }

        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }

      const bytes = readLock(file, fs);
      const record = parseLock(bytes);

      if (liveOwner(record, owner, deps)) {
        if (deps.now() >= deadline) {
          throw new DataHomeError(`Папкой данных ${path.dirname(path.dirname(file))} уже пользуется сервер `
            + `(pid ${record!.pid}, копия ${record!.root}). Второй сервер с той же папкой не запускается: `
            + 'задайте другой GRIGDESK_HOME.');
        }

        deps.sleep(Math.min(200, deadline - deps.now()));
      } else {
        retireLock(file, bytes, owner, fs);
      }
    }
  } finally {
    fs.unlinkSync(temp);
  }
}

// Сравниваются PID и время старта, поэтому повторно выданный PID не получает чужой lock.
// Чужая или уже заменённая запись остаётся на месте: снимается только своя.
export function releaseDataHomeLock(file: string, owner: LockOwner, fs: BootFs): void {
  if (sameOwner(parseLock(readLock(file, fs)), owner)) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }
}

// Порядок обязателен: сторож до записи, realpath до .env, блокировка после чтения настроек.
// Дочерние процессы получают реальный путь, который принимают хранилища без ссылок.
export function prepareDataHome(input: CheckInput, deps: PrepareDeps): { home: string; lockPath: string } {
  const { fs } = deps;
  const selected = checkDataHome(input, fs);

  loadDataHomeEnv(envFilePath(input), input.env, fs);

  for (const directory of [selected, dataPath(selected, 'state')]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  const home = fs.realpathSync(selected);

  input.env.GRIGDESK_HOME = home;

  const lockPath = dataPath(home, 'lock');

  acquireDataHomeLock(lockPath, deps.owner, deps);

  return { home, lockPath };
}

// starttime различает повторное использование PID; отсутствие proc сохраняет проверку kill.
// Имя процесса может содержать пробелы и скобки, поэтому поля считаются после последней скобки.
export function processStarttime(pid: number): string | null {
  try {
    const text = nodeFs.readFileSync(`/proc/${pid}/stat`, 'utf8');

    return text.slice(text.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

// EPERM означает существующий процесс, даже когда проверяющему запрещён сигнал.
// Любая другая ошибка сигнала считается отсутствием процесса.
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
