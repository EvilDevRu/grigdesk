import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { acquireDataHomeLock, releaseDataHomeLock } from '../server/src/lib/dataHomeBoot.ts';
import type { BrandContext, BrandDeps } from './brandMoveCore.ts';

export type BrandFs = BrandDeps['fs'];

/**
 * Сравнивает пути по сегментам без обращения к файловой системе.
 * Соседний каталог с тем же префиксом не считается вложенным.
 */
export function inside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));

  return relative === '' || (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Отсутствующий файл штатен; ошибки доступа запрещают дальнейшие изменения.
 * Ссылка остаётся ссылкой, даже если её цель не существует.
 */
export function stat(file: string, fs: BrandFs): Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * До любого чтения защищает настоящий HOME от неверно заданного теста.
 * Затем проверяет реальных предков: ссылка из /tmp наружу не обходит границу.
 */
export function guardContext(context: BrandContext, fs: BrandFs): void {
  const roots = [context.codeRoot, context.userHome];
  const testing = process.env.NODE_TEST_CONTEXT !== undefined;

  if (roots.some((root) => !path.isAbsolute(root) || (testing && !inside(os.tmpdir(), root)))) {
    throw new Error('Тест переноса допускает только абсолютные пути внутри os.tmpdir().');
  }

  if (context.env.CLAUDECODE !== undefined) {
    throw new Error('Перенос выполняется владельцем из обычной консоли, не из агента чата.');
  }

  for (const root of roots) {
    if (testing && !inside(fs.realpathSync(os.tmpdir()), fs.realpathSync(root))) {
      throw new Error('Ссылка тестовой папки выходит за os.tmpdir().');
    }
  }

  const home = path.join(context.userHome, '.grigdesk');

  if (inside(context.codeRoot, home) || inside(home, context.codeRoot)) {
    throw new Error('Папка данных пересекается с корнем кода.');
  }
}

/**
 * Файлы данных читаются только внутри разрешённого дерева без ссылок в предках.
 * Это защищает и копии до изменений, и временные файлы атомарной публикации.
 */
export function assertPlainPath(root: string, file: string, fs: BrandFs): void {
  if (!inside(root, file)) {
    throw new Error(`Путь выходит за разрешённую папку: ${file}`);
  }

  let cursor = root;
  const parts = path.relative(root, file).split(path.sep).filter(Boolean);

  for (const part of ['', ...parts]) {
    cursor = part ? path.join(cursor, part) : cursor;

    if (stat(cursor, fs)?.isSymbolicLink()) {
      throw new Error(`Перенос не следует по ссылке: ${cursor}`);
    }
  }
}

/**
 * Отпечаток содержит права, тип и байты, но не выдаёт содержимое в сообщениях.
 * Каталоги обходятся без разыменования ссылок, в устойчивом порядке имён.
 */
export function fingerprint(file: string, fs: BrandFs): string | null {
  const info = stat(file, fs);

  if (!info) {
    return null;
  }

  const hash = createHash('sha256');

  if (info.isSymbolicLink()) {
    hash.update(`link:${fs.readlinkSync(file)}`);
  } else if (info.isDirectory()) {
    hash.update(`dir:${info.mode & 0o777}`);

    for (const name of fs.readdirSync(file).sort()) {
      hash.update(JSON.stringify([name, fingerprint(path.join(file, name), fs)]));
    }
  } else if (info.isFile() && info.nlink === 1) {
    hash.update(`file:${info.mode & 0o777}:`);
    hash.update(fs.readFileSync(file));
  } else {
    throw new Error(`Необычный файл или жёсткие ссылки: ${file}`);
  }

  return hash.digest('hex');
}

/**
 * Даёт будущий отпечаток файла ещё до записи его новой версии.
 * Права входят в сравнение наравне с байтами содержимого.
 */
export function bytesFingerprint(bytes: string | Buffer, mode: number): string {
  return createHash('sha256').update(`file:${mode}:`).update(bytes).digest('hex');
}

/**
 * Сравнивает буквальный адрес ссылки, не открывая её цель.
 * Формат совпадает с общим отпечатком существующей ссылки.
 */
export function linkFingerprint(target: string): string {
  return createHash('sha256').update(`link:${target}`).digest('hex');
}

/**
 * Публикует файл атомарно после fsync, сохраняя заданные права.
 * Временный файл создаётся исключительно и убирается при любой ошибке.
 */
export function atomicFile(file: string, bytes: string | Buffer, mode: number, fs: BrandFs): void {
  const temp = `${file}.${randomUUID()}.tmp`;

  try {
    const fd = fs.openSync(temp, 'wx', 0o600);

    try {
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file), fs);
  } finally {
    if (stat(temp, fs)) {
      fs.unlinkSync(temp);
    }
  }
}

/**
 * Подтверждает запись имён после атомарного переноса или удаления.
 * Ошибка синхронизации сохраняется как отказ операции, а не успешное завершение.
 */
export function syncDirectory(directory: string, fs: BrandFs): void {
  const fd = fs.openSync(directory, 'r');

  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Проверяет существование процесса без посылки сигнала завершения.
 * Запрет доступа означает живого владельца, а не свободное место.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Время рождения процесса отличает прежнего владельца от повторно выданного PID.
 * Недоступное значение оставляет проверку консервативной.
 */
export function starttime(pid: number, fs: BrandFs): string | null {
  try {
    const source = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');

    return source.slice(source.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Пользуется тем же замком, что и сервер, на всё время изменения данных.
 * Чужую запись при освобождении не удаляет; ожидание живого владельца отключено.
 */
export function lockHome(context: BrandContext, fs: BrandFs): () => void {
  const file = path.join(context.userHome, '.grigdesk/state/server.lock');
  const owner = {
    pid: process.pid,
    starttime: starttime(process.pid, fs) ?? '',
    root: context.codeRoot,
    startedAt: new Date().toISOString(),
  };

  acquireDataHomeLock(file, owner, {
    fs,
    alive,
    starttime: (pid) => starttime(pid, fs),
    now: Date.now,
    sleep: () => {},
    waitMs: 0,
  });

  return () => releaseDataHomeLock(file, owner, fs);
}
