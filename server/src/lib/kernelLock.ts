// Kernel flock, владение которым остаётся у parent-процесса.
//
// Parent открывает fd, child только атомарно ставит flock на унаследованный
// open-file-description и завершается. Пока parent не закрыл FileHandle, lock
// физически не может исчезнуть из-за задержанного события `child.exit`.
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

// Отказ замка называется кодом: вызывающий разводит «занято» и «недоступно» по нему,
// а не по тексту. Класс ошибки при этом принадлежит вызывающему — он и подставляет
// свой `errorFactory`, чтобы отказ читался в терминах его подсистемы.
export type LockErrorFactory = (code: string, message: string) => Error;

export interface KernelFileLockOptions {
  lockPath: string;
  timeoutMs?: number;
  binary?: string;
  timeoutCode?: string;
  unavailableCode?: string;
  lostCode?: string;
  label?: string;
  errorFactory?: LockErrorFactory;
}

// Взятый замок. Владение остаётся у этого процесса: пока `release()` не закрыл fd,
// снять блокировку физически нечем.
export interface KernelFileLock {
  assertHeld: () => void;
  assertPathIdentity: () => Promise<void>;
  release: () => Promise<void>;
}

function plainError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string };

  error.code = code;

  return error;
}

/** Текст брошенного значения: до сюда доезжают и ошибки Node, и чужие строки. */
function failureText(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message || error);
}

/**
 * Берёт kernel flock и возвращает ручку владения. Замок ставит дочерний `flock` на
 * унаследованный fd, а держит его этот процесс: задержанное событие `exit` ребёнка
 * не может освободить блокировку раньше времени.
 */
export async function acquireKernelFileLock({
  lockPath,
  timeoutMs = 5_000,
  binary = 'flock',
  timeoutCode = 'FILE_LOCK_TIMEOUT',
  unavailableCode = 'FILE_LOCK_UNAVAILABLE',
  lostCode = 'FILE_LOCK_LOST',
  label = lockPath,
  errorFactory = plainError,
}: KernelFileLockOptions): Promise<KernelFileLock> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle: FileHandle;

  try {
    handle = await fs.open(
      lockPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw errorFactory(
      unavailableCode,
      `Не удалось открыть kernel lock ${label}: ${failureText(error)}`,
    );
  }
  let stderr = '';
  try {
    const child = spawn(binary, [
      '--exclusive',
      '--timeout',
      String(Math.max(0.001, Number(timeoutMs) / 1000)),
      '3',
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', handle.fd],
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-2_000);
      });
      child.once('error', (error: unknown) => finish(errorFactory(
        unavailableCode,
        `Системный flock недоступен: ${failureText(error)}`,
      )));
      child.once('close', (code: number | null) => {
        if (code === 0) return finish();
        finish(errorFactory(
          code === 1 ? timeoutCode : unavailableCode,
          code === 1
            ? `Не удалось получить kernel lock ${label}`
            : `flock для ${label} завершился с кодом ${code}: ${stderr.trim()}`,
        ));
      });
    });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }

  let heldIdentity: Awaited<ReturnType<typeof handle.stat>>;

  try {
    heldIdentity = await handle.stat();
    if (!heldIdentity.isFile()) throw new Error('lock fd is not a regular file');
  } catch (error) {
    await handle.close().catch(() => {});
    throw errorFactory(
      lostCode,
      `Kernel lock ${label} нельзя закрепить по inode: ${failureText(error)}`,
    );
  }

  let released = false;
  return Object.freeze({
    assertHeld() {
      if (released || handle.fd < 0) {
        throw errorFactory(lostCode, `Kernel lock ${label} уже освобождён`);
      }
    },
    async assertPathIdentity() {
      if (released || handle.fd < 0) {
        throw errorFactory(lostCode, `Kernel lock ${label} уже освобождён`);
      }
      try {
        const [heldNow, atPath] = await Promise.all([
          handle.stat(),
          fs.lstat(lockPath),
        ]);
        if (!heldNow.isFile() || !atPath.isFile() || atPath.isSymbolicLink()
            || heldNow.dev !== heldIdentity.dev || heldNow.ino !== heldIdentity.ino
            || atPath.dev !== heldIdentity.dev || atPath.ino !== heldIdentity.ino) {
          throw new Error('lock path указывает на другой inode');
        }
      } catch (error) {
        throw errorFactory(
          lostCode,
          `Kernel lock ${label} потерял path identity: ${failureText(error)}`,
        );
      }
    },
    async release() {
      if (released) return;
      released = true;
      await handle.close();
    },
  });
}
