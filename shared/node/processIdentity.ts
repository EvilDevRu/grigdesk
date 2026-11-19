import { execFile, spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { promisify } from 'node:util';

import { sha256 } from './hash.ts';
import { isArm64MachOExecutable } from './machO.ts';

const execute = promisify(execFile);
const digestPattern = /^[a-f0-9]{64}$/u;
const starttimePattern = /^\d{7,26}$/u;
const identityKeys = 'executable,pgid,pid,ppid,sid,starttime,state,uid';
const censusKeys = 'pgid,pid,ppid,sid,starttime';
const helperFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type NativeHelper = { file: string; sha256: string };

export interface DarwinProcessCensusEntry {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  starttime: string;
}

export interface DarwinProcessIdentity extends DarwinProcessCensusEntry {
  uid: number;
  state: 'R' | 'T';
  executable: string;
}

export type DarwinProcessProbe =
  | { state: 'alive'; identity: DarwinProcessIdentity }
  | { state: 'dead' | 'unknown' };

let configuredHelper: NativeHelper | undefined;

/**
 * Проверяет заголовок ARM64 executable и точные байты из доверенного описания.
 * Обычный пользовательский файл либо чужая архитектура не подходят.
 */
function verifyHelper(bytes: Buffer, expected: string): void {
  if (!digestPattern.test(expected) || sha256(bytes) !== expected || !isArm64MachOExecutable(bytes)) {
    throw new Error('darwin_process_helper_invalid');
  }
}

function privateOwnerDirectory(stat: Stats): boolean {
  return stat.isDirectory() && stat.uid === process.getuid!() && (stat.mode & 0o077) === 0;
}

function sealedOwnedExecutable(stat: Stats): boolean {
  return stat.isFile() && stat.uid === process.getuid!() && stat.nlink === 1
    && [0o500, 0o555, 0o700].includes(stat.mode & 0o7777) && stat.size <= 8 * 1024 * 1024;
}

/**
 * Проверяет физический путь, владельца, неизменяемость файла и его SHA.
 * Для запуска принимается только обычный файл из приватного каталога владельца.
 */
async function checkedHelperBytes(helper: NativeHelper): Promise<Buffer> {
  if (!path.isAbsolute(helper.file)) {
    throw new Error('darwin_process_helper_invalid');
  }

  const directory = path.dirname(helper.file);
  const parent = await fs.lstat(directory);

  if (await fs.realpath(directory) !== directory || !privateOwnerDirectory(parent)) {
    throw new Error('darwin_process_helper_invalid');
  }

  const handle = await fs.open(helper.file, helperFlags);

  try {
    if (!sealedOwnedExecutable(await handle.stat())) {
      throw new Error('darwin_process_helper_invalid');
    }

    const bytes = await handle.readFile();

    verifyHelper(bytes, helper.sha256);

    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Подтверждает физический helper для синхронных ранних читателей.
 * Открывает только выбранный файл без ссылок и обязательно закрывает свой FD.
 */
function checkHelperSync({ file, sha256: expected }: NativeHelper): void {
  const directory = path.dirname(file);

  if (!path.isAbsolute(file) || realpathSync(directory) !== directory
    || !privateOwnerDirectory(lstatSync(directory))) {
    throw new Error('darwin_process_helper_invalid');
  }

  const descriptor = openSync(file, helperFlags);

  try {
    if (!sealedOwnedExecutable(fstatSync(descriptor))) {
      throw new Error('darwin_process_helper_invalid');
    }

    verifyHelper(readFileSync(descriptor), expected);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Центральный синхронный probe для раннего data-home и boolean сводки.
 * Отсутствие выхода, timeout и ошибки helper остаются unknown.
 */
function runDarwinProbeSync(args: string[]): { status: number | null; stdout: string } {
  const helper = configuredHelper;

  if (process.platform !== 'darwin' || !helper) {
    return { status: null, stdout: '' };
  }

  try {
    checkHelperSync(helper);

    return spawnSync(helper.file, args, {
      cwd: '/',
      env: {},
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 32 * 1024,
    });
  } catch {
    return { status: null, stdout: '' };
  }
}

/**
 * Синхронный execFile выбирает setsid из той же проверенной поставки.
 * Packaged runtime читает закрытый digest рядом с исполняемым файлом.
 */
export function darwinSetsidPath(runtime: { root: string; packaged: boolean }, env = process.env): string {
  const file = runtime.packaged ? path.join(runtime.root, 'server/runtime/darwin-tools/setsid')
    : env.GRIGDESK_TEST_SETSID_BIN ?? '';
  let digest = env.GRIGDESK_BUILD_SETSID_SHA256 ?? '';

  if (runtime.packaged) {
    const descriptor = openSync(`${file}.sha256`, helperFlags);

    try {
      const stat = fstatSync(descriptor);

      if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1 || stat.size !== 64
        || ![0o400, 0o444].includes(stat.mode & 0o7777)) {
        throw new Error('darwin_setsid_invalid');
      }

      digest = readFileSync(descriptor, 'utf8');
    } finally {
      closeSync(descriptor);
    }
  }

  checkHelperSync({ file, sha256: digest });

  return file;
}

/**
 * Проверяет точного серверного владельца задачи в ограниченной синхронной пробе.
 * Витрина сводки сохраняет прежний boolean, силовые действия требуют отдельного доказательства.
 */
export function readDarwinFactoryOwnerState(pid: number, task: string): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[1-9][0-9]{0,18}$/u.test(task)) {
    return 'unknown';
  }

  const { status } = runDarwinProbeSync(['factory-owner', String(pid), task]);

  switch (status) {
    case 0:
      return 'alive';
    case 3:
      return 'dead';
    default:
      return 'unknown';
  }
}

/**
 * Настраивает порт только из явно выбранного доверенного build или packaged entry.
 * Входы read/lock сами никогда не принимают путь к helper из окружения.
 */
export async function configureDarwinProcessHelper(file: string, digest: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  const helper = { file, sha256: digest };

  await checkedHelperBytes(helper);
  selectNativeHelper(helper);
}

/**
 * Ранний source bootstrap выполняет ту же проверку до чтения состояния D.
 * Установленный worker получает ресурс из собственного проверенного дерева.
 */
export function configureDarwinBuildProcessHelperSync(env = process.env): void {
  const helper = {
    file: env.GRIGDESK_BUILD_PROCESS_HELPER ?? '',
    sha256: env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256 ?? '',
  };

  checkHelperSync(helper);
  selectNativeHelper(helper);
}

/**
 * Порт может повторно получать тот же seal, а смена ресурса после старта запрещена.
 * Это сохраняет единую identity для всех владельцев в текущем процессе.
 */
function selectNativeHelper(helper: NativeHelper): void {
  if (configuredHelper
    && (configuredHelper.file !== helper.file || configuredHelper.sha256 !== helper.sha256)) {
    throw new Error('darwin_process_helper_already_configured');
  }

  configuredHelper = helper;
}

/**
 * Проверяет build helper до первого захвата lock из source entrypoint.
 * Отсутствующие inputs прерывают Darwin build до запуска внешних команд.
 */
export async function configureDarwinBuildProcessHelper(env = process.env): Promise<void> {
  if (process.platform === 'darwin' && !isSea()) {
    await configureDarwinProcessHelper(
      env.GRIGDESK_BUILD_PROCESS_HELPER ?? '',
      env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256 ?? '',
    );
  }
}

/**
 * Берёт SHA инструмента из того же приватного каталога выбранного runtime.
 * Проверка и чтение используют один обычный дескриптор без перехода по ссылке.
 */
async function readDarwinToolDigest(file: string): Promise<string> {
  const handle = await fs.open(file, helperFlags);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1 || stat.size !== 64
      || ![0o400, 0o444].includes(stat.mode & 0o7777)) {
      throw new Error('darwin_process_helper_invalid');
    }

    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Готовит окружение дочерней фабрики из выбранного R или запечатанного source build.
 * Helper и setsid всегда принадлежат одному набору runtime tools, а PATH здесь не расширяется.
 */
export async function darwinFactoryToolEnvironment(runtime: {
  root: string;
  packaged: boolean;
}, env = process.env): Promise<Record<string, string>> {
  const directory = path.join(runtime.root, 'server/runtime/darwin-tools');
  const helper = runtime.packaged ? path.join(directory, 'process-identity')
    : env.GRIGDESK_BUILD_PROCESS_HELPER ?? '';
  const setsid = runtime.packaged ? path.join(directory, 'setsid') : env.GRIGDESK_TEST_SETSID_BIN ?? '';
  const helperDigest = runtime.packaged ? await readDarwinToolDigest(`${helper}.sha256`)
    : env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256 ?? '';

  await checkedHelperBytes({ file: helper, sha256: helperDigest });

  try {
    const setsidDigest = runtime.packaged ? await readDarwinToolDigest(`${setsid}.sha256`)
      : env.GRIGDESK_BUILD_SETSID_SHA256 ?? '';

    await checkedHelperBytes({ file: setsid, sha256: setsidDigest });
  } catch (cause) {
    throw Object.assign(new Error('darwin_setsid_invalid', { cause }), { tool: 'setsid' });
  }

  return {
    FACTORY_DARWIN_PROCESS_HELPER: helper,
    FACTORY_DARWIN_PROCESS_HELPER_SHA256: helperDigest,
    FACTORY_DARWIN_SETSID: setsid,
  };
}

/**
 * Помещает ровно проверенные байты инструмента в SEA staging.
 * Имена ресурсов относительны к закрытой рабочей папке сборщика.
 */
export async function stageDarwinProcessAssets(
  work: string,
  env = process.env,
): Promise<Record<string, string>> {
  const digest = env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256 ?? '';
  const bytes = await checkedHelperBytes({
    file: env.GRIGDESK_BUILD_PROCESS_HELPER ?? '',
    sha256: digest,
  });

  await fs.writeFile(path.join(work, 'process-identity'), bytes, { flag: 'wx', mode: 0o500 });
  await fs.writeFile(path.join(work, 'process-identity.sha256'), digest, { flag: 'wx', mode: 0o400 });

  return {
    'process-identity': 'process-identity',
    'process-identity.sha256': 'process-identity.sha256',
  };
}

/**
 * Материализует подписанный SEA asset в приватном каталоге для одной пробы.
 * Вызывающий удаляет свою копию до возврата к операции с lock.
 */
async function materializeSeaHelper(): Promise<NativeHelper> {
  const bytes = Buffer.from(getAsset('process-identity'));
  const digest = getAsset('process-identity.sha256', 'utf8');
  const temporary = await fs.realpath(os.tmpdir());

  verifyHelper(bytes, digest);

  const directory = await fs.mkdtemp(path.join(temporary, 'grigdesk-process-'));
  const file = path.join(directory, 'process-identity');

  try {
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o500 });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });

    throw error;
  }

  return { file, sha256: digest };
}

/**
 * Оконный процесс может использовать стабильный maintenance из проверенного I.
 * Перед разрешённым узким действием сверяются физический executable и uid.
 */
async function assertDarwinMaintenance(file: string): Promise<void> {
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o555
    || await fs.realpath(file) !== file) {
    throw new Error('installation_maintenance_invalid');
  }
}

/**
 * Дочерний helper получает только FD3 и чистое окружение. Его выход
 * оставляет kernel lease прикреплённым к дескриптору, который держит родитель.
 */
async function runDarwinInstallPort(args: string[], fd: number, maintenance?: string): Promise<boolean> {
  const asset = isSea() ? await materializeSeaHelper() : undefined;

  try {
    const helper = asset ?? configuredHelper;
    const executable = helper?.file ?? maintenance;
    const argv = helper ? args : ['install-lock-fd'];

    if (!executable || !path.isAbsolute(executable)) {
      throw new Error('darwin_process_helper_invalid');
    }

    if (helper) {
      await checkedHelperBytes(helper);
    } else {
      await assertDarwinMaintenance(executable);
    }

    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(executable, argv, {
        cwd: '/',
        env: {},
        signal: AbortSignal.timeout(5000),
        stdio: ['ignore', 'ignore', 'ignore', fd],
      });

      child.once('error', reject);
      child.once('close', resolve);
    });

    if (code !== 0 && code !== 75) {
      throw new Error('installation_lock_unverified');
    }

    return code === 0;
  } finally {
    if (asset) {
      await fs.rm(path.dirname(asset.file), { recursive: true, force: true });
    }
  }
}

/**
 * FD остаётся открытым у вызывающего процесса до release.
 * Конкурент распознаётся отдельно от ошибки проверки helper.
 */
export async function tryDarwinInstallLease(fd: number, maintenance?: string): Promise<boolean> {
  return runDarwinInstallPort(['install-lock'], fd, maintenance);
}

/**
 * Оба имени закреплены одним физическим parent fd. Darwin rename с RENAME_EXCL
 * предотвращает замену неожиданно появившегося root.
 */
export async function publishDarwinInstallStage(staging: string, root: string): Promise<void> {
  const parent = path.dirname(root);

  if (path.dirname(staging) !== parent || await fs.realpath(parent) !== parent) {
    throw new Error('installation_path_invalid');
  }

  const directory = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

  try {
    if (!await runDarwinInstallPort(['publish-install-stage', path.basename(staging), path.basename(root)],
      directory.fd)) {
      throw new Error('installation_target_not_empty');
    }

    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Moves only the previously examined directory and never replaces another entry.
 * The native port syncs the physical parent before returning success.
 */
export async function moveDarwinLockDirectory(from: string, to: string,
  expected: { dev: bigint; ino: bigint }): Promise<void> {
  const parent = path.dirname(from);

  if (path.dirname(to) !== parent || await fs.realpath(parent) !== parent) {
    throw new Error('directory_lock_parent_invalid');
  }

  const directory = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

  try {
    if (!await runDarwinInstallPort([
      'move-lock-directory', path.basename(from), path.basename(to),
      String(expected.dev), String(expected.ino),
    ], directory.fd)) {
      throw new Error('directory_lock_rename_conflict');
    }
  } finally {
    await directory.close();
  }
}

/**
 * Формат ответа закрыт и привязан к запрошенному PID и собственному UID.
 * Физический executable подтверждается перед выдачей данных потребителям.
 */
function parseIdentity(stdout: string, pid: number): DarwinProcessIdentity {
  const value = JSON.parse(stdout) as DarwinProcessIdentity;

  if (!value || Object.keys(value).sort().join(',') !== identityKeys
    || value.pid !== pid || value.uid !== process.getuid!()
    || ![value.ppid, value.pgid, value.sid].every((id) => Number.isSafeInteger(id) && id > 0)
    || typeof value.starttime !== 'string' || !starttimePattern.test(value.starttime)
    || (value.state !== 'R' && value.state !== 'T')
    || typeof value.executable !== 'string' || !path.isAbsolute(value.executable)) {
    throw new Error('darwin_process_identity_invalid');
  }

  return value;
}

/**
 * Пробы сборки требуют заранее настроенный helper и не распаковывают SEA asset.
 * Таймаут и отмена относятся только к непосредственному процессу этой пробы.
 */
async function runDarwinBuildProbe(args: string[], signal: AbortSignal, maxBuffer: number): Promise<string> {
  const asset = isSea() ? await materializeSeaHelper() : undefined;
  const helper = asset ?? configuredHelper;

  try {
    if (!helper || process.platform !== 'darwin') {
      throw new Error('darwin_process_helper_invalid');
    }

    signal.throwIfAborted();
    await checkedHelperBytes(helper);
    signal.throwIfAborted();

    const { stdout } = await execute(helper.file, args, {
      cwd: '/',
      env: {},
      signal,
      timeout: 2000,
      killSignal: 'SIGKILL',
      maxBuffer,
    });

    return stdout;
  } finally {
    if (asset) {
      await fs.rm(path.dirname(asset.file), { recursive: true, force: true });
    }
  }
}

/**
 * Native census возвращает только свои PID с точно ожидаемым executable.
 * Плохой либо неполный ответ считается неразрешимым владельцем.
 */
export async function findDarwinDesktopProcesses(executable: string): Promise<number[]> {
  const stdout = await runDarwinBuildProbe(
    ['installed-desktop-census', executable], AbortSignal.timeout(5000), 64 * 1024,
  );
  const list = JSON.parse(stdout) as number[];

  if (!Array.isArray(list) || list.some((pid) => !Number.isSafeInteger(pid) || pid <= 1)
    || new Set(list).size !== list.length) {
    throw new Error('release_desktop_owner_unknown');
  }

  return list;
}

/**
 * Различает поколения процесса по boot UUID до чтения launch records.
 * Ошибка либо неполный ответ остаются исключением, а не отсутствием процесса.
 */
export async function readDarwinBootId(): Promise<string> {
  const output = await runDarwinBuildProbe(['boot-id'], AbortSignal.timeout(2000), 512);
  const id = output.trim().toLowerCase();

  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) {
    throw new Error('darwin_boot_id_invalid');
  }

  return id;
}

/**
 * Принимает только полный снимок своей UID с собственной записью вызывающего.
 * Пропуски, дубликаты и ошибки helper не превращаются в пустой census.
 */
export async function readDarwinProcessCensus(signal: AbortSignal): Promise<DarwinProcessCensusEntry[]> {
  const stdout = await runDarwinBuildProbe(['uid-census'], signal, 8 * 1024 * 1024);
  const rows = JSON.parse(stdout) as DarwinProcessCensusEntry[];
  const seen = new Set<number>();

  if (!Array.isArray(rows)) {
    throw new Error('darwin_process_census_invalid');
  }

  for (const row of rows) {
    if (!row || Object.keys(row).sort().join(',') !== censusKeys
      || ![row.pid, row.pgid, row.sid].every((id) => Number.isSafeInteger(id) && id > 0)
      || !Number.isSafeInteger(row.ppid) || row.ppid < 0 || seen.has(row.pid)
      || typeof row.starttime !== 'string' || !starttimePattern.test(row.starttime)) {
      throw new Error('darwin_process_census_invalid');
    }

    seen.add(row.pid);
  }

  if (!seen.has(process.pid)) {
    throw new Error('darwin_process_census_incomplete');
  }

  return rows;
}

/**
 * Сигнал конкретному участнику проверяется внутри нативного helper.
 * Повторно выданный PID или другая группа никогда не получают этот сигнал.
 */
export async function signalDarwinBuildMember(row: DarwinProcessCensusEntry,
  name: 'TERM' | 'INT' | 'KILL', signal: AbortSignal): Promise<void> {
  try {
    await runDarwinBuildProbe([
      'signal-stage-member', String(row.pid), row.starttime, String(row.sid), String(row.pgid), name,
    ], signal, 4096);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 3) {
      throw error;
    }
  }
}

/**
 * Native host-quiescer получает только удержанные FD runner binding и каталога.
 * Неизвестный native status не превращается в успешное завершение группы.
 */
export async function quiesceDarwinRunnerFile(descriptors: {
  file: number;
  directory: number;
  lock: number;
  lockDirectory: number;
}, signal: AbortSignal): Promise<void> {
  const helper = configuredHelper;

  if (!helper || process.platform !== 'darwin') {
    throw new Error('darwin_process_helper_invalid');
  }

  signal.throwIfAborted();
  await checkedHelperBytes(helper);
  signal.throwIfAborted();

  const { file, directory, lock, lockDirectory } = descriptors;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(helper.file, ['quiesce-bound-runner'], {
      cwd: '/',
      env: {},
      signal,
      stdio: ['ignore', 'ignore', 'ignore', file, directory, lock, lockDirectory],
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(code === 75 ? 'release_drain_busy' : 'release_activity_unknown'));
      }
    });
  });
}

/**
 * Отдаёт start token ранней синхронной блокировке и отдельно маркирует dead.
 * Недоступный executable или helper не позволяют признать владельца завершившимся.
 */
export function readDarwinStarttimeSync(pid: number): { starttime: string | null; dead: boolean } {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { starttime: null, dead: false };
  }

  const { status, stdout } = runDarwinProbeSync(['identity', String(pid)]);

  if (status === 0) {
    try {
      return { starttime: parseIdentity(stdout, pid).starttime, dead: false };
    } catch {
      return { starttime: null, dead: false };
    }
  }

  return { starttime: null, dead: status === 3 };
}

/**
 * Читает идентичность процесса через проверенный Darwin helper с ограничением вывода и срока.
 * Только его код подтверждённого отсутствия считается dead, все прочие отказы остаются unknown.
 */
export async function readDarwinProcessIdentity(
  pid: number, maintenance?: string,
): Promise<DarwinProcessProbe> {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 0) {
    return { state: 'unknown' };
  }

  try {
    const asset = isSea() ? await materializeSeaHelper() : undefined;
    const helper = asset ?? configuredHelper;
    const executable = helper?.file ?? maintenance;

    if (!executable || !path.isAbsolute(executable)) {
      return { state: 'unknown' };
    }

    try {
      if (helper) {
        await checkedHelperBytes(helper);
      } else {
        await assertDarwinMaintenance(executable);
      }

      const { stdout } = await execute(executable, [helper ? 'identity' : 'inspect-process', String(pid)], {
        cwd: '/',
        env: {},
        timeout: 2000,
        maxBuffer: 32 * 1024,
      });

      const identity = parseIdentity(stdout, pid);

      return {
        state: 'alive',
        identity: { ...identity, executable: await fs.realpath(identity.executable) },
      };
    } finally {
      if (asset) {
        await fs.rm(path.dirname(asset.file), { recursive: true, force: true });
      }
    }
  } catch (error) {
    return { state: (error as { code?: unknown } | null)?.code === 3 ? 'dead' : 'unknown' };
  }
}

/**
 * Сохраняет неизвестность для недоступного процесса и отличает повторно выданный PID.
 * Запись владельца с другим временем старта не удерживает свой прежний lock.
 */
export async function darwinProcessOwnerState(
  owner: { pid: number; starttime: string },
  read = readDarwinProcessIdentity,
): Promise<'alive' | 'dead' | 'unknown'> {
  const probe = await read(owner.pid);

  if (probe.state !== 'alive') {
    return probe.state;
  }

  if (probe.identity.pid !== owner.pid) {
    return 'unknown';
  }

  return probe.identity.starttime === owner.starttime ? 'alive' : 'dead';
}
