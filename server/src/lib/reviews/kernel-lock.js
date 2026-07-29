// Kernel flock, владение которым остаётся у parent-процесса.
//
// Parent открывает fd, child только атомарно ставит flock на унаследованный
// open-file-description и завершается. Пока parent не закрыл FileHandle, lock
// физически не может исчезнуть из-за задержанного события `child.exit`.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function plainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function acquireKernelFileLock({
  lockPath,
  timeoutMs = 5_000,
  binary = 'flock',
  timeoutCode = 'FILE_LOCK_TIMEOUT',
  unavailableCode = 'FILE_LOCK_UNAVAILABLE',
  lostCode = 'FILE_LOCK_LOST',
  label = lockPath,
  errorFactory = plainError,
} = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await fs.open(lockPath, 'a', 0o600);
  } catch (error) {
    throw errorFactory(
      unavailableCode,
      `Не удалось открыть kernel lock ${label}: ${error?.message || error}`,
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
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-2_000);
      });
      child.once('error', (error) => finish(errorFactory(
        unavailableCode,
        `Системный flock недоступен: ${error?.message || error}`,
      )));
      child.once('close', (code) => {
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

  let released = false;
  return Object.freeze({
    assertHeld() {
      if (released || handle.fd < 0) {
        throw errorFactory(lostCode, `Kernel lock ${label} уже освобождён`);
      }
    },
    async release() {
      if (released) return;
      released = true;
      await handle.close();
    },
  });
}
