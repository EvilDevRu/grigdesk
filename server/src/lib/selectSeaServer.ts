import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, promisify } from 'node:util';

import { desktopRuntimePath, parseRuntimeDescriptor } from '../../../shared/desktop/desktopRuntime.ts';
import { acquireDirectoryLock, type DirectoryLock } from '../../../shared/node/directoryLock.ts';
import { readTextOrNull, syncDirectory } from '../../../shared/node/files.ts';
import { probeServerBinary, verifyServerBinary } from '../../../shared/node/serverBinaryRuntime.ts';
import { isNodeVersionSupported } from './nodeVersion.ts';
import { isDirectRun } from './helperEntry.ts';
import { verifySeaRuntime } from '../../../shared/node/seaRuntime.ts';
import { dataHome, dataPath, envFilePath } from '../../../shared/runtime/dataHome.ts';
import { checkDataHome, processStarttime } from './dataHomeBoot.ts';

export interface SelectSeaServerInput {
  root: string;
  windowVersion?: 4;
  expectedPrevious?: string | null;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  home?: string;
  verify?: (root: string) => Promise<void>;
  verifyBinary?: (binary: string, env: NodeJS.ProcessEnv) => Promise<void>;
  node?: string;
  verifySource?: (root: string, node: string) => Promise<void>;
  afterRename?: (phase: 'backup' | 'primary') => Promise<void>;
}

/**
 * Отсутствующий lock допустим, повреждённый или недоступный владелец закрывает выбор.
 * PID/starttime читаются через proc: ни нулевых, ни останавливающих сигналов нет.
 */
export async function assertDataIdle(home: string): Promise<void> {
  let text: string;

  try {
    text = await readFile(dataPath(home, 'lock'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  const owner = JSON.parse(text) as { pid?: number; starttime?: string };

  if (!Number.isSafeInteger(owner.pid) || !owner.pid || owner.pid < 1 || !owner.starttime) {
    throw new Error('Блокировка папки данных повреждена; проверьте владельца вручную.');
  }

  const current = processStarttime(owner.pid);
  const exists = await stat(`/proc/${owner.pid}`).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return false;
    }

    throw error;
  });

  if (current === owner.starttime || exists && !current) {
    throw new Error(`Папкой данных уже пользуется сервер (pid ${owner.pid}); закройте его перед выбором.`);
  }
}

/**
 * Старые профили не переносятся и не выбираются автоматически вместе с новым R.
 * Явный каталог задаёт человек; без него наличие source-профилей требует решения.
 */
async function assertProfiles(input: {
  previousRoot: string;
  root: string;
  env: NodeJS.ProcessEnv;
  home: string;
  dataHome: string;
}): Promise<void> {
  const settings = await readFile(envFilePath(input), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return '';
    }

    throw new Error('Не удалось проверить настройки профилей папки данных.');
  });
  const configured = parseEnv(settings).FACTORY_PROFILES_DIR;
  const explicit = input.env.FACTORY_PROFILES_DIR || configured;

  if (explicit) {
    if (!path.isAbsolute(explicit) || await realpath(explicit) !== path.resolve(explicit)
      || !(await stat(explicit)).isDirectory()) {
      throw new Error('FACTORY_PROFILES_DIR должен указывать на существующий абсолютный каталог.');
    }

    if (explicit !== configured && (configured
      || path.resolve(explicit) !== dataPath(input.dataHome, 'profiles'))) {
      throw new Error('Сохраните выбранный FACTORY_PROFILES_DIR в .env папки данных для будущего окна.');
    }

    return;
  }

  for (const candidate of new Set([input.previousRoot, input.root])) {
    if (await stat(path.join(candidate, 'profiles')).catch(() => null)) {
      throw new Error('Найдены прежние профили: явно выберите FACTORY_PROFILES_DIR перед сменой сервера.');
    }
  }
}

const execute = promisify(execFile);

/**
 * Физический ordinary ELF проверяется до любой metadata-пробы.
 * O_NOFOLLOW/NONBLOCK и fstat запрещают ссылки, FIFO и устройства даже при подмене пути.
 */
export async function assertServerBinaryFile(binary: string): Promise<void> {
  const handle = await open(binary,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);

  try {
    const stat = await handle.stat();

    if (!stat.isFile()) {
      throw new Error('Сервер должен быть физическим обычным ELF');
    }

    const magic = Buffer.alloc(4);

    await handle.read(magic, 0, 4, 0);

    if (!stat.isFile() || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || await realpath(binary) !== binary) {
      throw new Error('Сервер должен быть физическим обычным ELF');
    }

    await fs.promises.access(binary, fs.constants.X_OK);
  } finally {
    await handle.close();
  }
}

/**
 * Проверяет публичный контракт и полный verify выбранного ELF без запуска API.
 * PackageId закрепляется между двумя пробами, loader-переменные не наследуются.
 */
async function verifyBinary(
  binary: string, parent: NodeJS.ProcessEnv, signal?: AbortSignal,
): Promise<void> {
  const info = await probeServerBinary(binary, { signal });

  await verifyServerBinary(binary, {
    home: parent.GRIGDESK_HOME!,
    expectPackageId: info.packageId,
    timeoutMs: 120000,
    signal,
  });
}

/**
 * Возврат в source требует явного Node и существующего серверного входа.
 * Версия запрашивается с очищенными Node options до публикации descriptor.
 */
async function verifySource(root: string, node: string): Promise<void> {
  if (!(await stat(path.join(root, 'server/src/app.ts'))).isFile()) {
    throw new Error('В выбранном source нет серверного входа.');
  }

  const env = { ...process.env };

  delete env.NODE_OPTIONS;

  const version = await execute(node, ['-p', 'process.versions.node'], { env, timeout: 5000 });

  if (!isNodeVersionSupported(version.stdout.trim())) {
    throw new Error('Для исходников требуется поддерживаемый Node.');
  }
}

/**
 * Private временный файл синхронизируется до своего rename.
 * Ошибка записи не меняет primary или previous descriptor.
 */
async function writePrivate(file: string, text: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600);

  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Выбор ELF, прежнего R и source использует общий lock/CAS/backup protocol.
 * Проверки обеих папок данных и профилей выполняются до первой публикации.
 */
export async function selectSeaServer(input: SelectSeaServerInput): Promise<string> {
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const runtimePath = desktopRuntimePath({ env, home });
  const directory = path.dirname(runtimePath);
  const supported = await readFile(path.join(directory, 'runtime-version'), 'utf8').catch(() => '');
  const root = await realpath(input.root);
  const binary = (await stat(root)).isFile();

  const portable = input.windowVersion === 4 && binary;

  if (!portable && (!['3', '4'].includes(supported.trim()) || binary && supported.trim() !== '4')) {
    throw new Error('Сначала установите обновлённое окно: grigdesk-ctl desktop install.');
  }

  input.signal?.throwIfAborted();

  if (portable) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const previous = Object.hasOwn(input, 'expectedPrevious')
    ? input.expectedPrevious! : await readTextOrNull(runtimePath);
  const lock = await acquireSelectionLock(runtimePath);
  const temporary = `${runtimePath}.${randomUUID()}.tmp`;
  const temporaryBackup = `${temporary}.previous`;

  try {
    await recoverSelectionLocked(runtimePath);

    if (await readTextOrNull(runtimePath) !== previous) {
      throw new Error('Описание сервера изменилось во время проверки; повторите выбор.');
    }

    const descriptor = previous === null ? null : parseRuntimeDescriptor(previous);

    if (!descriptor && !(portable && previous === null)) {
      throw new Error('Описание прежнего сервера повреждено; восстановите runtime.json перед выбором.');
    }

    const selectionEnv = !Object.hasOwn(env, 'GRIGDESK_HOME') && descriptor && descriptor.version !== 1
      ? { ...env, GRIGDESK_HOME: descriptor.home } : env;
    const previousHome = descriptor && descriptor.version !== 1
      ? descriptor.home : dataHome({ env: {}, home });
    const selectedHome = checkDataHome({
      codeRoot: binary ? path.dirname(path.dirname(root)) : root,
      home,
      env: selectionEnv,
    }, fs);

    await assertProfiles({
      previousRoot: descriptor?.version === 4
        ? path.dirname(path.dirname(descriptor.binary))
        : descriptor?.root ?? path.dirname(path.dirname(root)),
      root: binary ? path.dirname(path.dirname(root)) : root,
      env: selectionEnv,
      home,
      dataHome: selectedHome,
    });
    await assertDataIdle(selectedHome);

    if (previousHome !== selectedHome) {
      await assertDataIdle(previousHome);
    }

    let next;

    if (input.node) {
      const node = await realpath(input.node);

      await (input.verifySource ?? verifySource)(root, node);
      next = {
        version: 2,
        root,
        node,
        home: selectedHome,
      };
    } else if (binary) {
      await assertServerBinaryFile(root);
      await (input.verifyBinary ?? verifyBinary)(root, { ...env, GRIGDESK_HOME: selectedHome },
        input.signal);
      next = {
        version: 4,
        kind: 'binary',
        binary: root,
        home: selectedHome,
        cliPaths: descriptor?.version === 4 ? descriptor.cliPaths
          : descriptor && descriptor.version <= 2 && 'node' in descriptor
            ? [path.dirname(descriptor.node)] : [],
      };
    } else {
      await (input.verify ?? verifySeaRuntime)(root);
      next = {
        version: 3,
        kind: 'sea',
        root,
        home: selectedHome,
      };
    }


    await assertDataIdle(selectedHome);

    if (previousHome !== selectedHome) {
      await assertDataIdle(previousHome);
    }

    input.signal?.throwIfAborted();

    if (await readTextOrNull(runtimePath) !== previous) {
      throw new Error('Описание сервера изменилось во время проверки; повторите выбор.');
    }

    if (JSON.stringify(descriptor) === JSON.stringify(next)) {
      return runtimePath;
    }

    await writePrivate(`${runtimePath}.transaction`, JSON.stringify({
      format: 1,
      token: path.basename(temporary).slice(path.basename(runtimePath).length + 1, -4),
      previous,
      next: JSON.stringify(next) + '\n',
      backup: await readTextOrNull(`${runtimePath}.previous`),
    }));
    await syncDirectory(directory);
    await writePrivate(temporary, JSON.stringify(next) + '\n');

    if (previous !== null) {
      await writePrivate(temporaryBackup, previous);
      await rename(temporaryBackup, `${runtimePath}.previous`);
    }

    await input.afterRename?.('backup');
    await rename(temporary, runtimePath);
    await input.afterRename?.('primary');
    await syncDirectory(directory);
    await rm(`${runtimePath}.transaction`);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
    await rm(temporaryBackup, { force: true });
    await lock.release();
  }

  return runtimePath;
}

/**
 * Явный source использует тот же протокол выбора и резервирования.
 * Отдельный install окна для возврата к исходникам не требуется.
 */
export async function selectSourceServer(input: SelectSeaServerInput & { node: string }): Promise<string> {
  return selectSeaServer(input);
}

/**
 * Loader и writer сериализуются одним owner-lock с PID/starttime/token.
 * Живой, unknown и прежний ownerless lock сохраняются для проверки владельцем.
 */
async function acquireSelectionLock(runtimePath: string): Promise<DirectoryLock> {
  try {
    return await acquireDirectoryLock(`${runtimePath}.select-lock`, { waitMs: 100, pollMs: 10 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'directory_lock_busy') {
      throw error;
    }

    throw Object.assign(new Error(`Выбор сервера заблокирован: ${runtimePath}.select-lock; `
      + 'проверьте владельца и повторите выбор.'), { code: 'server_selection_busy' });
  }
}

/**
 * Journal private и закрытый: чужие ссылки и неизвестные поля не восстанавливаются.
 * Сравнение точных primary bytes различает rollback, commit и внешний конфликт.
 */
async function recoverSelectionLocked(runtimePath: string): Promise<void> {
  const file = `${runtimePath}.transaction`;
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (!stat) {
    return;
  }

  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600
    || stat.size > 256 * 1024) {
    throw Object.assign(new Error('Некорректный журнал выбора сервера.'), {
      code: 'server_selection_invalid',
    });
  }

  const handle = await open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let journal;

  try {
    journal = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }

  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || Object.keys(journal).sort().join(',') !== 'backup,format,next,previous,token'
    || journal.format !== 1 || journal.previous !== null && typeof journal.previous !== 'string'
    || typeof journal.next !== 'string'
    || journal.backup !== null && typeof journal.backup !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(journal.token)) {
    throw Object.assign(new Error('Некорректный журнал выбора сервера.'), {
      code: 'server_selection_invalid',
    });
  }

  const primary = await readTextOrNull(runtimePath);

  if (primary !== journal.previous && primary !== journal.next) {
    throw Object.assign(new Error('Descriptor изменился вне транзакции выбора сервера.'), {
      code: 'server_selection_conflict',
    });
  }

  const temporary = `${runtimePath}.${journal.token}.tmp`;
  const backup = primary === journal.next ? journal.previous : journal.backup;
  const recovered = `${runtimePath}.${randomUUID()}.recovery`;

  try {
    if (backup === null) {
      await rm(`${runtimePath}.previous`, { force: true });
    } else {
      await writePrivate(recovered, backup);
      await rename(recovered, `${runtimePath}.previous`);
    }

    await syncDirectory(path.dirname(runtimePath));
    await rm(temporary, { force: true });
    await rm(`${temporary}.previous`, { force: true });
    await rm(file);
    await syncDirectory(path.dirname(runtimePath));
  } finally {
    await rm(recovered, { force: true });
  }
}

/**
 * Восстановление выполняется до чтения descriptor и под тем же lock, что выбор.
 * Только доказанно мёртвый owner reclaimed общим directoryLock, без ручного обхода.
 */
export async function recoverRuntimeSelection(runtimePath: string): Promise<void> {
  const lock = await acquireSelectionLock(runtimePath);

  try {
    await recoverSelectionLocked(runtimePath);
  } finally {
    await lock.release();
  }
}

/**
 * CLI принимает ровно один ELF/R либо source с явно заданным Node.
 * Отказы не останавливают владельца данных и не изменяют настройки службы.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const portable = argv.length === 2 && argv[0] === '--portable';
  const source = argv.length === 4 && argv[0] === '--source' && argv[2] === '--node';

  if (!(argv.length === 1 && !argv[0]!.startsWith('-')) && !source && !portable) {
    process.stderr.write('Использование: use-server <ELF|R> или use-source <root> --node <node>\n');

    return 2;
  }

  try {
    const selected = await selectSeaServer({
      root: source || portable ? argv[1]! : argv[0]!,
      windowVersion: portable ? 4 : undefined,
      node: source ? argv[3] : undefined,
    });

    process.stdout.write(`Выбран сервер GrigDesk: ${selected}\n`);

    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);

    return 1;
  }
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
