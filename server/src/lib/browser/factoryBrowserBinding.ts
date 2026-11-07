import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

import { isPlainRecord } from '../../../../shared/lib/objects.ts';

export interface BrowserRunProof {
  task: string;
  stage: string;
  runId: string;
  epoch: string;
  attemptId: string;
  token: string;
}

export interface BrowserProcesses {
  stat(pid: number): Promise<string>;
  bootId(): Promise<string>;
}

export interface BrowserRun {
  task: string;
  stage: string;
  runId: string;
  epoch: string;
  tokenHash: string;
  runner: string;
  pid: number;
  pgid: number;
  session: number;
  starttime: string;
  bootId: string;
  identity: string;
}

export interface BrowserRunBinding {
  schema: 1;
  task: string;
  stage: string;
  attemptId: string;
  profile: string;
  catalogHash: string;
  route: string;
  routeHash: string;
  node: string;
  sequence: number;
  headEventHash: string;
  runId: string;
  epoch: string;
  tokenHash: string;
  runner: string;
  pid: number;
  pgid: number;
  session: number;
  starttime: string;
  bootId: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const DECIMAL = /^[1-9][0-9]*$/u;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const NODE = /^[a-z0-9][a-z0-9_-]{0,40}$/u;
const BOOT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const BINDING_KEYS = [
  'schema', 'task', 'stage', 'attemptId', 'profile', 'catalogHash', 'route', 'routeHash',
  'node', 'sequence', 'headEventHash', 'runId', 'epoch', 'tokenHash', 'runner', 'pid',
  'pgid', 'session', 'starttime', 'bootId',
];

export const linuxBrowserProcesses: BrowserProcesses = {
  stat: (pid) => readFile(`/proc/${pid}/stat`, 'utf8'),
  bootId: async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
};

/**
 * Ошибки файлов и разбора не раскрывают секрет, пути control root или стек.
 * Caller получает один стабильный отказ до отправки browser effect.
 */
export function browserAuthorityError(): never {
  throw new Error('browser_run_stale');
}

/**
 * Proof имеет закрытую форму и приходит только из trusted relay closure.
 * Публичный hash не заменяет предъявление секрета действующего запуска.
 */
export function parseBrowserRunProof(value: unknown): BrowserRunProof {
  const keys = ['task', 'stage', 'runId', 'epoch', 'attemptId', 'token'];

  if (!isPlainRecord(value) || Object.keys(value).sort().join() !== keys.sort().join()
    || typeof value.task !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value.task)
    || typeof value.stage !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.stage)
    || typeof value.runId !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/u.test(value.runId)
    || value.runId === '.' || value.runId === '..'
    || typeof value.epoch !== 'string' || !DECIMAL.test(value.epoch)
    || typeof value.attemptId !== 'string' || !/^a_[a-f0-9]{32}$/u.test(value.attemptId)
    || typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 4096
    || /[\r\n\0]/u.test(value.token)) {
    return browserAuthorityError();
  }

  return { ...value } as unknown as BrowserRunProof;
}

/**
 * Все родители внутри control root защищены от provider-writable подмены.
 * Проверка пути не исправляет чужие права и не следует символическим ссылкам.
 */
async function privateParents(root: string, file: string): Promise<void> {
  if (!path.isAbsolute(root) || root === '/' || path.resolve(root) !== root
    || !file.startsWith(root + path.sep) || await realpath(root) !== root) {
    return browserAuthorityError();
  }

  let directory = path.dirname(file);

  while (directory === root || directory.startsWith(root + path.sep)) {
    const stat = await lstat(directory);

    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
      return browserAuthorityError();
    }

    if (directory === root) {
      return;
    }

    directory = path.dirname(directory);
  }

  return browserAuthorityError();
}

/**
 * Metadata и содержимое читаются по одному открытому дескриптору.
 * Проверка размера повторяется после bounded read, а hardlink не даёт alias control-файлу.
 */
async function privateText(root: string, file: string): Promise<string> {
  await privateParents(root, file);

  if (await realpath(file) !== file) {
    return browserAuthorityError();
  }

  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384
      || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())) {
      return browserAuthorityError();
    }

    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead !== stat.size || bytesRead > 16384) {
      return browserAuthorityError();
    }

    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Старый engine env-format имеет ровно один экземпляр каждого ожидаемого ключа.
 * Лишнее поле, строка без equals или duplicate переводят authority в отказ.
 */
function envRecord(text: string, keys: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);

  for (const line of text.split('\n').filter(Boolean)) {
    const index = line.indexOf('=');
    const key = line.slice(0, index);

    if (index < 1 || !keys.includes(key) || Object.hasOwn(fields, key)) {
      return browserAuthorityError();
    }

    fields[key] = line.slice(index + 1);
  }

  if (Object.keys(fields).sort().join() !== [...keys].sort().join()) {
    return browserAuthorityError();
  }

  return fields;
}

/**
 * Один снимок связывает active capability с protected launcher и реальным процессом.
 * Счётчики CPU и состояние T/S/R не входят в identity и не создают ложный stale.
 */
export async function readBrowserRun(root: string, raw: unknown,
  processes: BrowserProcesses = linuxBrowserProcesses,
): Promise<BrowserRun> {
  const proof = parseBrowserRunProof(raw);

  try {
    const activeText = await privateText(root,
      path.join(root, 'runs', `t${proof.task}`, `${proof.stage}.active`));
    const active = envRecord(activeText, ['SCHEMA', 'RUN_ID', 'EPOCH', 'TOKEN_HASH', 'STATE']);
    const tokenHash = createHash('sha256').update(proof.token).digest('hex');

    if (active.SCHEMA !== '1' || active.STATE !== 'active' || active.RUN_ID !== proof.runId
      || active.EPOCH !== proof.epoch || !HASH.test(active.TOKEN_HASH ?? '')
      || !timingSafeEqual(Buffer.from(active.TOKEN_HASH!), Buffer.from(tokenHash))) {
      return browserAuthorityError();
    }

    const liveText = await privateText(root,
      path.join(root, 'runner-processes', `t${proof.task}.active`));
    const live = envRecord(liveText, [
      'SCHEMA', 'TASK', 'STAGE', 'RUN_ID', 'EPOCH', 'RUNNER', 'PID', 'PGID', 'SESSION',
      'STARTTIME', 'STATE',
    ]);
    const pid = Number(live.PID);

    if (live.SCHEMA !== '1' || live.TASK !== proof.task || live.STAGE !== proof.stage
      || live.RUN_ID !== proof.runId || live.EPOCH !== proof.epoch || live.STATE !== 'active'
      || !ID.test(live.RUNNER ?? '') || !DECIMAL.test(live.PID ?? '')
      || !Number.isSafeInteger(pid) || live.PGID !== live.PID || live.SESSION !== live.PID
      || !DECIMAL.test(live.STARTTIME ?? '')) {
      return browserAuthorityError();
    }

    const bootId = await processes.bootId();
    const proc = await processes.stat(pid);
    const end = proc.lastIndexOf(')');
    const fields = proc.slice(end + 2).trim().split(/\s+/u);

    if (!BOOT.test(bootId) || !proc.startsWith(`${pid} (`) || end < 1
      || fields.length < 20 || !/^[RSDTtWIP]$/u.test(fields[0] ?? '')
      || fields[2] !== live.PGID || fields[3] !== live.SESSION
      || fields[19] !== live.STARTTIME) {
      return browserAuthorityError();
    }

    return {
      task: proof.task,
      stage: proof.stage,
      runId: proof.runId,
      epoch: proof.epoch,
      tokenHash,
      runner: live.RUNNER!,
      pid,
      pgid: pid,
      session: pid,
      starttime: live.STARTTIME!,
      bootId,
      identity: createHash('sha256').update(activeText + '\0' + liveText + '\0' + bootId).digest('hex'),
    };
  } catch {
    return browserAuthorityError();
  }
}

/**
 * Binding JSON — закрытый control record, а не расширяемое сообщение модели.
 * Все части адреса и числа проверяются до их использования следующими readers.
 */
export function decodeBrowserBinding(raw: unknown): BrowserRunBinding {
  if (!isPlainRecord(raw) || Object.keys(raw).sort().join() !== [...BINDING_KEYS].sort().join()
    || raw.schema !== 1 || typeof raw.task !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(raw.task)
    || typeof raw.stage !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.stage)
    || typeof raw.attemptId !== 'string' || !/^a_[a-f0-9]{32}$/u.test(raw.attemptId)
    || typeof raw.profile !== 'string' || !ID.test(raw.profile)
    || typeof raw.route !== 'string' || !NODE.test(raw.route)
    || typeof raw.node !== 'string' || !NODE.test(raw.node)
    || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 0
    || !['catalogHash', 'routeHash', 'headEventHash', 'tokenHash'].every((key) =>
      typeof raw[key] === 'string' && HASH.test(raw[key] as string))
    || typeof raw.runId !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/u.test(raw.runId)
    || raw.runId === '.' || raw.runId === '..'
    || typeof raw.epoch !== 'string' || !DECIMAL.test(raw.epoch)
    || typeof raw.runner !== 'string' || !ID.test(raw.runner)
    || !Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0
    || raw.pgid !== raw.pid || raw.session !== raw.pid
    || typeof raw.starttime !== 'string' || !DECIMAL.test(raw.starttime)
    || typeof raw.bootId !== 'string' || !BOOT.test(raw.bootId)) {
    return browserAuthorityError();
  }

  return { ...raw } as unknown as BrowserRunBinding;
}

/**
 * Чтение run binding не восстанавливает право по одному существованию файла.
 * Caller отдельно сверяет его с текущим run, process identity и trusted visit.
 */
export async function readBrowserBinding(root: string, raw: unknown): Promise<BrowserRunBinding> {
  const proof = parseBrowserRunProof(raw);

  try {
    const text = await privateText(root,
      path.join(root, 'browser-runs', `t${proof.task}`, `${proof.runId}.json`));

    return decodeBrowserBinding(JSON.parse(text));
  } catch {
    return browserAuthorityError();
  }
}

/**
 * Полностью записанный временный файл публикуется атомарно и без overwrite.
 * До окончания cleanup publisher не выпускает provider и не посылает readiness.
 */
export async function writeBrowserBinding(root: string, raw: unknown): Promise<void> {
  const value = decodeBrowserBinding(raw);
  const browserRoot = path.join(root, 'browser-runs');
  const directory = path.join(browserRoot, `t${value.task}`);

  await privateParents(root, path.join(root, '.browser-directory-check'));

  for (const parent of [browserRoot, directory]) {
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    await privateParents(root, path.join(parent, '.browser-directory-check'));
  }

  const file = path.join(directory, `${value.runId}.json`);

  await privateParents(root, file);

  const temporary = path.join(directory, `.${value.runId}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);

  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
    await handle.close();
    await link(temporary, file);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Cleanup снимает только binding собственного exact run и не удаляет новую запись.
 * Отсутствие своего файла идемпотентно; недоверенное существующее содержимое — отказ.
 */
export async function removeBrowserBinding(root: string, raw: unknown): Promise<void> {
  const proof = parseBrowserRunProof(raw);
  const file = path.join(root, 'browser-runs', `t${proof.task}`, `${proof.runId}.json`);

  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    return browserAuthorityError();
  }

  const value = await readBrowserBinding(root, proof);
  const expected = createHash('sha256').update(proof.token).digest('hex');

  if (value.task !== proof.task || value.stage !== proof.stage || value.runId !== proof.runId
    || value.epoch !== proof.epoch || value.attemptId !== proof.attemptId
    || value.tokenHash !== expected) {
    return browserAuthorityError();
  }

  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}
