// Надёжные примитивы приватного состояния, общие для журнала аналитики, неизменяемых записей
// и очистки. Все операции с целями привязаны к уже проверенному дескриптору каталога;
// пути и необработанные сообщения системных вызовов не пересекают публичную границу ошибок.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER_PATH = fileURLToPath(new URL('./dirfd-helper.py', import.meta.url));
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const HELPER_OUTPUT_CAP = 64 * 1024;
const HELPER_TIMEOUT_MS = 15_000;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const BASENAME_RE = /^[A-Za-z0-9._-]{1,240}$/;
const TEMP_RE = /^\.analytics-tmp-([a-f0-9]{64})-([a-f0-9]{16,})\.tmp$/;

export const DURABLE_FS_STAGES = Object.freeze({
  DIRECTORY_READY: 'directory_ready',
  STABLE_FILE_OPENED: 'stable_file_opened',
  STABLE_BYTES_READ: 'stable_bytes_read',
  STABLE_FILE_VERIFIED: 'stable_file_verified',
  TEMP_FSYNCED: 'temp_fsynced',
  TARGET_LINKED: 'target_linked',
  TARGET_DIRECTORY_FSYNCED: 'target_directory_fsynced',
  EXISTING_TARGET_READ: 'existing_target_read',
  TEMP_UNLINKED: 'temp_unlinked',
  CLEANUP_DIRECTORY_FSYNCED: 'cleanup_directory_fsynced',
  EXACT_UNLINK_VALIDATED: 'exact_unlink_validated',
  EXACT_UNLINKED: 'exact_unlinked',
  EXACT_UNLINK_DIRECTORY_FSYNCED: 'exact_unlink_directory_fsynced',
});

export class AnalyticsDurableFsError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AnalyticsDurableFsError';
    this.code = code;
    if (details !== undefined) this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new AnalyticsDurableFsError(code, message, details);
}

function safeIoFailure(error) {
  if (error instanceof AnalyticsDurableFsError) return error;
  return new AnalyticsDurableFsError(
    'durableIoFailure',
    'Операция durable analytics state не завершена.',
    error?.code ? { syscallCode: String(error.code) } : undefined,
  );
}

function assertDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) {
    fail('invalidDirectory', 'Каталог durable state задан некорректно.');
  }
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) {
    fail('invalidDirectory', 'Корневой каталог нельзя использовать как durable state directory.');
  }
  return resolved;
}

function assertName(name) {
  if (typeof name !== 'string' || !BASENAME_RE.test(name) || name === '.' || name === '..') {
    fail('invalidName', 'Имя durable state файла задано некорректно.');
  }
  return name;
}

function assertRequiredMode(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 0o777)) {
    fail('invalidMode', 'Ожидаемый mode durable state задан некорректно.');
  }
  return value;
}

function assertLimit(value, fallback = DEFAULT_MAX_BYTES) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 2 ** 31) {
    fail('invalidLimit', 'Ограничение размера durable state задано некорректно.');
  }
  return limit;
}

function asBytes(value, maxBytes) {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : typeof value === 'string'
        ? Buffer.from(value, 'utf8')
        : null;
  if (!bytes) fail('invalidBytes', 'Immutable publication требует bytes или UTF-8 строку.');
  if (bytes.length > maxBytes) fail('fileTooLarge', 'Durable state превышает допустимый размер.');
  return Buffer.from(bytes);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function permissions(stat) {
  return Number(stat.mode & 0o777n);
}

function fingerprint(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    mode: String(permissions(stat)),
    nlink: String(stat.nlink),
  });
}

function assertFingerprint(value, { requireNlink = false } = {}) {
  if (!value || typeof value !== 'object'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('invalidFingerprint', 'Fingerprint durable state задан некорректно.');
  }
  const required = ['dev', 'ino', 'size', 'mtimeNs'];
  if (requireNlink) required.push('nlink');
  for (const key of required) {
    if (typeof value[key] !== 'string' || value[key].length > 32 || !UINT_RE.test(value[key])) {
      fail('invalidFingerprint', 'Fingerprint durable state задан некорректно.');
    }
  }
  for (const key of ['mode', 'nlink']) {
    if (value[key] !== undefined
        && (typeof value[key] !== 'string' || value[key].length > 32 || !UINT_RE.test(value[key]))) {
      fail('invalidFingerprint', 'Fingerprint durable state задан некорректно.');
    }
  }
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    ...(value.nlink === undefined ? {} : { nlink: value.nlink }),
  });
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    fail('invalidOption', `Параметр ${name} должен быть boolean.`);
  }
  return value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function matchesFingerprint(stat, expected, { includeNlink = true } = {}) {
  const actual = fingerprint(stat);
  return ['dev', 'ino', 'size', 'mtimeNs', 'mode']
    .every((key) => expected[key] === undefined || actual[key] === expected[key])
    && (!includeNlink || expected.nlink === undefined || actual.nlink === expected.nlink);
}

function procEntry(directoryHandle, name) {
  return `/proc/self/fd/${directoryHandle.fd}/${name}`;
}

async function emitStage(runtime, stage, values = {}) {
  await runtime.stage(stage, Object.freeze({ ...values }));
}

function defaultSyscalls() {
  return {
    mkdir: fsMkdir,
    lstat: fsLstat,
    open: fsOpen,
    randomBytes,
    dirfdOperation: runDirfdOperation,
  };
}

async function readChildOutput(stream, state, field) {
  stream.on('data', (chunk) => {
    state[field] += chunk.toString('utf8');
    if (Buffer.byteLength(state[field], 'utf8') > HELPER_OUTPUT_CAP) {
      state.overflow = true;
    }
  });
}

async function runDirfdOperation({
  directoryHandle,
  request,
  pythonBinary = 'python3',
  helperPath = HELPER_PATH,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(pythonBinary, [helperPath], {
        stdio: ['pipe', 'pipe', 'pipe', directoryHandle.fd],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const output = { stdout: '', stderr: '', overflow: false };
    readChildOutput(child.stdout, output, 'stdout');
    readChildOutput(child.stderr, output, 'stderr');
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (output.overflow) {
        reject(Object.assign(new Error('helper output overflow'), { code: 'EOVERFLOW' }));
        return;
      }
      if (code !== 0 || signal) {
        reject(Object.assign(new Error('helper process failed'), { code: 'EHELPER' }));
        return;
      }
      try {
        const parsed = JSON.parse(output.stdout.trim());
        if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') {
          throw new Error('invalid helper response');
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('invalid helper response'), { code: 'EPROTO' }));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

async function openValidatedDirectory(runtime, directory, { create, privateDirectory }) {
  const resolved = assertDirectory(directory);
  const components = resolved.split(path.sep).filter(Boolean);
  const flags = FS_CONSTANTS.O_RDONLY
    | (FS_CONSTANTS.O_DIRECTORY || 0)
    | (FS_CONSTANTS.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await runtime.syscalls.open(path.parse(resolved).root, flags);
    for (const component of components) {
      const anchored = procEntry(handle, component);
      let namedBefore;
      let created = false;
      try {
        namedBefore = await runtime.syscalls.lstat(anchored, { bigint: true });
      } catch (error) {
        if (error?.code !== 'ENOENT' || !create) throw error;
        try {
          await runtime.syscalls.mkdir(anchored, { mode: 0o700 });
          created = true;
          // Создание дочернего directory entry durable только после fsync родителя.
          await handle.sync();
        } catch (mkdirError) {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
        }
        namedBefore = await runtime.syscalls.lstat(anchored, { bigint: true });
      }
      if (!namedBefore.isDirectory() || namedBefore.isSymbolicLink()) {
        fail('unsafeDirectory', 'Компонент durable state path не является обычным каталогом.');
      }
      const child = await runtime.syscalls.open(anchored, flags);
      let childAccepted = false;
      try {
        const opened = await child.stat({ bigint: true });
        const namedAfter = await runtime.syscalls.lstat(anchored, { bigint: true });
        if (!opened.isDirectory() || !sameIdentity(opened, namedBefore)
            || !sameIdentity(opened, namedAfter)) {
          fail('unsafeDirectory', 'Компонент durable state path изменился во время открытия.');
        }
        if (created && permissions(opened) !== 0o700) await child.chmod(0o700);
        if (created) await child.sync();
        childAccepted = true;
      } finally {
        if (!childAccepted) await child.close().catch(() => {});
      }
      const parent = handle;
      handle = child;
      await parent.close();
    }

    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory()) fail('unsafeDirectory', 'Durable state fd не является каталогом.');
      if (privateDirectory && permissions(opened) !== 0o700) {
        await handle.chmod(0o700);
      }
      const hardened = await handle.stat({ bigint: true });
      if (!hardened.isDirectory() || (privateDirectory && permissions(hardened) !== 0o700)) {
        fail('unsafeDirectory', 'Durable state directory не имеет private mode.');
      }
      if (create || privateDirectory) await handle.sync();
      await emitStage(runtime, DURABLE_FS_STAGES.DIRECTORY_READY);
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      handle = null;
      throw error;
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof AnalyticsDurableFsError) throw error;
    if (!create && error?.code === 'ENOENT') {
      fail('directoryMissing', 'Durable state directory отсутствует.');
    }
    if (['ELOOP', 'ENOTDIR'].includes(error?.code)) {
      fail('unsafeDirectory', 'Durable state directory не прошёл nofollow-проверку.');
    }
    throw safeIoFailure(error);
  }
}

async function stableReadWithHandle(runtime, directoryHandle, {
  name,
  maxBytes,
  expectedFingerprint = null,
  expectedSha256 = null,
  requiredMode = null,
  requireSingleLink = true,
}) {
  const trustedName = assertName(name);
  const limit = assertLimit(maxBytes);
  assertRequiredMode(requiredMode);
  const expected = expectedFingerprint ? assertFingerprint(expectedFingerprint) : null;
  if (expectedSha256 !== null && !SHA256_RE.test(expectedSha256)) {
    fail('invalidHash', 'SHA-256 durable state задан некорректно.');
  }

  const anchoredPath = procEntry(directoryHandle, trustedName);
  let handle;
  try {
    const flags = FS_CONSTANTS.O_RDONLY
      | (FS_CONSTANTS.O_NOFOLLOW || 0)
      | (FS_CONSTANTS.O_NONBLOCK || 0);
    handle = await runtime.syscalls.open(anchoredPath, flags);
    const before = await handle.stat({ bigint: true });
    const namedBefore = await runtime.syscalls.lstat(anchoredPath, { bigint: true });
    if (!before.isFile() || !namedBefore.isFile()) {
      fail('unsafeFile', 'Durable state target не является обычным файлом.');
    }
    if (!sameIdentity(before, namedBefore)) {
      fail('fileChanged', 'Durable state target изменился во время открытия.');
    }
    if (requiredMode !== null && permissions(before) !== requiredMode) {
      fail('unsafeFile', 'Durable state target имеет недопустимый mode.');
    }
    if (requireSingleLink && before.nlink !== 1n) {
      fail('unsafeFile', 'Durable state target имеет несколько hardlinks.');
    }
    if (expected && !matchesFingerprint(before, expected)) {
      fail('fileChanged', 'Fingerprint durable state target изменился.');
    }
    if (before.size > BigInt(limit)) {
      fail('fileTooLarge', 'Durable state target превышает допустимый размер.');
    }
    await emitStage(runtime, DURABLE_FS_STAGES.STABLE_FILE_OPENED, {
      size: String(before.size),
    });

    const declaredSize = Number(before.size);
    const bytes = Buffer.alloc(declaredSize);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    await emitStage(runtime, DURABLE_FS_STAGES.STABLE_BYTES_READ, {
      bytes: offset + extraBytes,
    });
    const after = await handle.stat({ bigint: true });
    let namedAfter;
    try {
      namedAfter = await runtime.syscalls.lstat(anchoredPath, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') fail('fileChanged', 'Durable state target исчез во время чтения.');
      throw error;
    }
    if (offset !== bytes.length || extraBytes !== 0 || !sameSnapshot(before, after)
        || !sameSnapshot(after, namedAfter)) {
      fail('fileChanged', 'Durable state target изменился во время чтения.');
    }
    const digest = sha256(bytes);
    if (expectedSha256 !== null && digest !== expectedSha256) {
      fail('hashMismatch', 'SHA-256 durable state target не совпал.');
    }
    await emitStage(runtime, DURABLE_FS_STAGES.STABLE_FILE_VERIFIED, {
      bytes: bytes.length,
      sha256: digest,
    });
    return Object.freeze({
      bytes,
      sha256: digest,
      fingerprint: fingerprint(after),
    });
  } catch (error) {
    if (error instanceof AnalyticsDurableFsError) throw error;
    if (error?.code === 'ENOENT') fail('fileMissing', 'Durable state target отсутствует.');
    if (['ELOOP', 'ENXIO', 'ENODEV'].includes(error?.code)) {
      fail('unsafeFile', 'Durable state target не прошёл nofollow-проверку.');
    }
    throw safeIoFailure(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function helper(runtime, directoryHandle, request) {
  try {
    const response = await runtime.syscalls.dirfdOperation({
      directoryHandle,
      request,
      pythonBinary: runtime.pythonBinary,
      helperPath: runtime.helperPath,
    });
    if (!response || typeof response.status !== 'string') {
      throw Object.assign(new Error('invalid helper response'), { code: 'EPROTO' });
    }
    return response;
  } catch (error) {
    throw safeIoFailure(error);
  }
}

function helperError(response, fallbackCode = 'durableIoFailure') {
  const mapping = {
    missing: 'fileMissing',
    changed: 'fileChanged',
    hash_mismatch: 'hashMismatch',
    too_large: 'fileTooLarge',
    unsafe_file: 'unsafeFile',
    unsafe_mode: 'unsafeFile',
    unsafe_directory: 'unsafeDirectory',
    link_uncertain: 'publishUncertain',
    io_failure: 'durableIoFailure',
    helper_failure: 'durableIoFailure',
    cross_device: 'durableIoFailure',
  };
  const code = mapping[response.code] || fallbackCode;
  return new AnalyticsDurableFsError(code, 'Dirfd-операция durable state не завершена.');
}

async function exactUnlinkWithHandle(runtime, directoryHandle, {
  name,
  snapshot,
  maxBytes,
  requiredMode = null,
  privateDirectory = true,
}) {
  const response = await helper(runtime, directoryHandle, {
    operation: 'unlink',
    name,
    fingerprint: snapshot.fingerprint,
    sha256: snapshot.sha256,
    maxBytes,
    requiredMode,
    privateDirectory,
  });
  if (response.status === 'unlinked') return response;
  if (response.status === 'missing' || response.status === 'changed') {
    fail('exactTargetChanged', 'Exact durable state target изменился перед unlink.');
  }
  if (response.status === 'uncertain') {
    fail('unlinkUncertain', 'Результат exact unlink требует reconciliation.');
  }
  if (response.status === 'error') {
    if (['missing', 'changed', 'hash_mismatch', 'too_large', 'unsafe_file', 'unsafe_mode']
      .includes(response.code)) {
      fail('exactTargetChanged', 'Exact durable state target изменился перед unlink.');
    }
    throw helperError(response);
  }
  fail('durableIoFailure', 'Dirfd helper вернул неизвестный результат.');
}

async function cleanupTemp(runtime, directoryHandle, {
  name,
  snapshot,
  maxBytes,
}) {
  await exactUnlinkWithHandle(runtime, directoryHandle, {
    name,
    snapshot,
    maxBytes,
    requiredMode: 0o600,
  });
  await emitStage(runtime, DURABLE_FS_STAGES.TEMP_UNLINKED, { sha256: snapshot.sha256 });
  try {
    await directoryHandle.sync();
  } catch {
    fail('publishUncertain', 'Cleanup immutable publication требует recovery.');
  }
  await emitStage(runtime, DURABLE_FS_STAGES.CLEANUP_DIRECTORY_FSYNCED, {
    sha256: snapshot.sha256,
  });
}

async function ensurePrivateDirectoryImpl(runtime, { directory } = {}) {
  const handle = await openValidatedDirectory(runtime, directory, {
    create: true,
    privateDirectory: true,
  });
  try {
    const result = fingerprint(await handle.stat({ bigint: true }));
    return Object.freeze({ mode: 0o700, fingerprint: result });
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readStableFileImpl(runtime, {
  directory,
  name,
  maxBytes = DEFAULT_MAX_BYTES,
  expectedFingerprint = null,
  expectedSha256 = null,
  requiredMode = null,
  privateDirectory = false,
  requireSingleLink = true,
} = {}) {
  assertBoolean(privateDirectory, 'privateDirectory');
  assertBoolean(requireSingleLink, 'requireSingleLink');
  const handle = await openValidatedDirectory(runtime, directory, {
    create: false,
    privateDirectory,
  });
  try {
    return await stableReadWithHandle(runtime, handle, {
      name,
      maxBytes,
      expectedFingerprint,
      expectedSha256,
      requiredMode,
      requireSingleLink,
    });
  } finally {
    await handle.close().catch(() => {});
  }
}

async function publishImmutableImpl(runtime, {
  directory,
  name,
  bytes: input,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const targetName = assertName(name);
  const limit = assertLimit(maxBytes);
  const bytes = asBytes(input, limit);
  const digest = sha256(bytes);
  let suffix;
  try {
    const entropy = runtime.syscalls.randomBytes(12);
    if (!Buffer.isBuffer(entropy) || entropy.length !== 12) {
      throw Object.assign(new Error('invalid entropy'), { code: 'ERANDOM' });
    }
    suffix = entropy.toString('hex');
  } catch (error) {
    throw safeIoFailure(error);
  }
  const tempName = `.analytics-tmp-${digest}-${suffix}.tmp`;
  const directoryHandle = await openValidatedDirectory(runtime, directory, {
    create: true,
    privateDirectory: true,
  });
  let tempHandle;
  let tempSnapshot;
  try {
    const flags = FS_CONSTANTS.O_WRONLY
      | FS_CONSTANTS.O_CREAT
      | FS_CONSTANTS.O_EXCL
      | (FS_CONSTANTS.O_NOFOLLOW || 0);
    try {
      tempHandle = await runtime.syscalls.open(procEntry(directoryHandle, tempName), flags, 0o600);
      await tempHandle.chmod(0o600);
      await tempHandle.writeFile(bytes);
      await tempHandle.sync();
      const written = await tempHandle.stat({ bigint: true });
      const named = await runtime.syscalls.lstat(procEntry(directoryHandle, tempName), { bigint: true });
      if (!written.isFile() || !named.isFile() || !sameIdentity(written, named)
          || written.size !== BigInt(bytes.length) || permissions(written) !== 0o600
          || written.nlink !== 1n) {
        fail('unsafeTemp', 'Immutable publication temp не прошёл identity validation.');
      }
      tempSnapshot = Object.freeze({ bytes, sha256: digest, fingerprint: fingerprint(written) });
      await tempHandle.close();
      tempHandle = null;
    } catch (error) {
      if (error instanceof AnalyticsDurableFsError) throw error;
      throw safeIoFailure(error);
    }
    await emitStage(runtime, DURABLE_FS_STAGES.TEMP_FSYNCED, {
      bytes: bytes.length,
      sha256: digest,
    });

    const linked = await helper(runtime, directoryHandle, {
      operation: 'link',
      source: tempName,
      target: targetName,
      fingerprint: tempSnapshot.fingerprint,
      sha256: digest,
      maxBytes: limit,
      requiredMode: 0o600,
      privateDirectory: true,
    });
    if (linked.status === 'linked') {
      await emitStage(runtime, DURABLE_FS_STAGES.TARGET_LINKED, {
        bytes: bytes.length,
        sha256: digest,
      });
      try {
        await directoryHandle.sync();
      } catch {
        fail('publishUncertain', 'Immutable target связан, но directory fsync не подтверждён.');
      }
      await emitStage(runtime, DURABLE_FS_STAGES.TARGET_DIRECTORY_FSYNCED, {
        sha256: digest,
      });
      await cleanupTemp(runtime, directoryHandle, {
        name: tempName,
        // linkat увеличил nlink; helper сверяет текущую identity/hash и сам наблюдает decrement.
        snapshot: Object.freeze({
          ...tempSnapshot,
          fingerprint: Object.freeze({ ...tempSnapshot.fingerprint, nlink: '2' }),
        }),
        maxBytes: limit,
      });
      const installed = await stableReadWithHandle(runtime, directoryHandle, {
        name: targetName,
        maxBytes: limit,
        expectedSha256: digest,
        requiredMode: 0o600,
      });
      if (!installed.bytes.equals(bytes)) {
        fail('publishUncertain', 'Опубликованный immutable target не совпал с source bytes.');
      }
      return Object.freeze({
        outcome: 'published',
        bytes: bytes.length,
        sha256: digest,
        fingerprint: installed.fingerprint,
      });
    }

    if (linked.status !== 'exists') {
      if (linked.status === 'error') throw helperError(linked);
      fail('durableIoFailure', 'Dirfd helper вернул неизвестный результат.');
    }

    let existing = null;
    let conflictReason = null;
    try {
      existing = await stableReadWithHandle(runtime, directoryHandle, {
        name: targetName,
        maxBytes: limit,
        requiredMode: 0o600,
      });
    } catch (error) {
      conflictReason = error;
    }
    await emitStage(runtime, DURABLE_FS_STAGES.EXISTING_TARGET_READ, {
      sha256: existing?.sha256 ?? null,
    });
    await cleanupTemp(runtime, directoryHandle, {
      name: tempName,
      snapshot: tempSnapshot,
      maxBytes: limit,
    });
    if (conflictReason || !existing || existing.sha256 !== digest || !existing.bytes.equals(bytes)) {
      throw new AnalyticsDurableFsError(
        'immutableConflict',
        'Immutable target уже существует с другим содержимым.',
        Object.freeze({
          requestedSha256: digest,
          existingSha256: existing?.sha256 ?? null,
          requestedBytes: bytes.length,
          existingBytes: existing?.bytes.length ?? null,
        }),
      );
    }
    return Object.freeze({
      outcome: 'idempotent',
      bytes: bytes.length,
      sha256: digest,
      fingerprint: existing.fingerprint,
    });
  } finally {
    await tempHandle?.close().catch(() => {});
    await directoryHandle.close().catch(() => {});
  }
}

async function recoverOrphanTempImpl(runtime, {
  directory,
  name,
  expectedSha256,
  expectedFingerprint = null,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const tempName = assertName(name);
  const match = TEMP_RE.exec(tempName);
  if (!match || !SHA256_RE.test(expectedSha256) || match[1] !== expectedSha256) {
    fail('orphanMismatch', 'Orphan temp не принадлежит ожидаемой immutable publication.');
  }
  const limit = assertLimit(maxBytes);
  const directoryHandle = await openValidatedDirectory(runtime, directory, {
    create: false,
    privateDirectory: true,
  });
  try {
    let snapshot;
    try {
      snapshot = await stableReadWithHandle(runtime, directoryHandle, {
        name: tempName,
        maxBytes: limit,
        expectedFingerprint,
        expectedSha256,
        requiredMode: 0o600,
        requireSingleLink: false,
      });
    } catch (error) {
      if (error?.code === 'fileMissing') return Object.freeze({ outcome: 'missing' });
      if (error instanceof AnalyticsDurableFsError) {
        throw new AnalyticsDurableFsError(
          'orphanMismatch',
          'Orphan temp не прошёл identity/hash validation.',
        );
      }
      throw error;
    }
    if (!['1', '2'].includes(snapshot.fingerprint.nlink)) {
      fail('orphanMismatch', 'Orphan temp имеет недопустимое число hardlinks.');
    }
    await cleanupTemp(runtime, directoryHandle, {
      name: tempName,
      snapshot,
      maxBytes: limit,
    });
    return Object.freeze({
      outcome: 'removed',
      bytes: snapshot.bytes.length,
      sha256: snapshot.sha256,
      fingerprint: snapshot.fingerprint,
    });
  } finally {
    await directoryHandle.close().catch(() => {});
  }
}

async function unlinkExactFileImpl(runtime, {
  directory,
  name,
  expectedFingerprint,
  expectedSha256,
  maxBytes = DEFAULT_MAX_BYTES,
  requiredMode = null,
  requireSingleLink = true,
  privateDirectory = false,
} = {}) {
  const targetName = assertName(name);
  const expected = assertFingerprint(expectedFingerprint);
  assertRequiredMode(requiredMode);
  assertBoolean(requireSingleLink, 'requireSingleLink');
  assertBoolean(privateDirectory, 'privateDirectory');
  if (!SHA256_RE.test(expectedSha256)) {
    fail('invalidHash', 'Exact unlink требует ожидаемый SHA-256.');
  }
  const limit = assertLimit(maxBytes);
  const directoryHandle = await openValidatedDirectory(runtime, directory, {
    create: false,
    privateDirectory,
  });
  try {
    let snapshot;
    try {
      snapshot = await stableReadWithHandle(runtime, directoryHandle, {
        name: targetName,
        maxBytes: limit,
        expectedFingerprint: expected,
        expectedSha256,
        requiredMode,
        requireSingleLink,
      });
    } catch (error) {
      if (error instanceof AnalyticsDurableFsError) {
        throw new AnalyticsDurableFsError(
          'exactTargetChanged',
          'Exact durable state target не совпал с подготовленным fingerprint.',
        );
      }
      throw error;
    }
    if (requireSingleLink && snapshot.fingerprint.nlink !== '1') {
      fail('exactTargetChanged', 'Exact durable state target имеет несколько hardlinks.');
    }
    await emitStage(runtime, DURABLE_FS_STAGES.EXACT_UNLINK_VALIDATED, {
      bytes: snapshot.bytes.length,
      sha256: snapshot.sha256,
    });
    await exactUnlinkWithHandle(runtime, directoryHandle, {
      name: targetName,
      snapshot,
      maxBytes: limit,
      requiredMode,
      privateDirectory,
    });
    await emitStage(runtime, DURABLE_FS_STAGES.EXACT_UNLINKED, {
      bytes: snapshot.bytes.length,
      sha256: snapshot.sha256,
    });
    try {
      await directoryHandle.sync();
    } catch {
      fail('unlinkUncertain', 'Exact unlink выполнен, но directory fsync не подтверждён.');
    }
    await emitStage(runtime, DURABLE_FS_STAGES.EXACT_UNLINK_DIRECTORY_FSYNCED, {
      sha256: snapshot.sha256,
    });
    return Object.freeze({
      outcome: 'removed',
      bytes: snapshot.bytes.length,
      sha256: snapshot.sha256,
      fingerprint: snapshot.fingerprint,
    });
  } finally {
    await directoryHandle.close().catch(() => {});
  }
}

/**
 * Создаёт изолированный экземпляр с injectable syscalls/stage hook для crash tests.
 * Подмена должна сохранять сигнатуры fs.promises; dirfdOperation получает только fd
 * каталога и basename-ориентированный JSON request.
 */
export function createDurableFs({
  syscalls = {},
  stage = async () => {},
  pythonBinary = 'python3',
  helperPath = HELPER_PATH,
} = {}) {
  if (!syscalls || typeof syscalls !== 'object' || typeof stage !== 'function') {
    throw new TypeError('createDurableFs: syscalls object и stage function обязательны.');
  }
  const runtime = Object.freeze({
    syscalls: Object.freeze({ ...defaultSyscalls(), ...syscalls }),
    stage,
    pythonBinary,
    helperPath,
  });
  return Object.freeze({
    ensurePrivateDirectory: (input) => ensurePrivateDirectoryImpl(runtime, input),
    readStableFile: (input) => readStableFileImpl(runtime, input),
    publishImmutable: (input) => publishImmutableImpl(runtime, input),
    recoverOrphanTemp: (input) => recoverOrphanTempImpl(runtime, input),
    unlinkExactFile: (input) => unlinkExactFileImpl(runtime, input),
  });
}

const DEFAULT_DURABLE_FS = createDurableFs();

export const ensurePrivateDirectory = DEFAULT_DURABLE_FS.ensurePrivateDirectory;
export const readStableFile = DEFAULT_DURABLE_FS.readStableFile;
export const publishImmutable = DEFAULT_DURABLE_FS.publishImmutable;
export const recoverOrphanTemp = DEFAULT_DURABLE_FS.recoverOrphanTemp;
export const unlinkExactFile = DEFAULT_DURABLE_FS.unlinkExactFile;
