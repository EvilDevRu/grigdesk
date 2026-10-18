import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ServerRuntime } from './runtimeConfig.ts';

/**
 * Открывает журнал до запуска ребёнка, чтобы stdout и stderr писали в один файл.
 * Дескриптор принадлежит вызывающему коду и закрывается им после spawn.
 */
export function openServerLog(file: string): number {
  mkdirSync(path.dirname(file), { recursive: true });

  if (existsSync(file) && statSync(file).size > 10 * 1024 * 1024) {
    renameSync(file, `${file}.1`);
  }

  return openSync(file, 'a', 0o600);
}

/**
 * Запускает системный Node из описания установки через явный порт spawn.
 * Значения окружения не входят в аргументы командной строки.
 */
export function spawnServer(runtime: ServerRuntime, logFd: number, spawnImpl = spawn): ChildProcess {
  return spawnImpl(runtime.node, [path.join(runtime.root, 'server/src/app.ts')], {
    cwd: path.join(runtime.root, 'server'),
    env: runtime.env,
    stdio: ['ignore', logFd, logFd, 'ipc'],
    serialization: 'json',
    detached: false,
    shell: false,
  });
}

/**
 * Возвращает исход проверки маршрута из собственного процесса ворот.
 * Отмена ограничивает только этот процесс и не затрагивает сервер или службу.
 */
export function runVpnGate(
  runtime: ServerRuntime,
  signal: AbortSignal,
  spawnImpl = spawn,
): Promise<{ code: number; lastLine: string }> {
  if (signal.aborted) {
    return Promise.resolve({
      code: 1,
      lastLine: '',
    });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    let stderr = '';
    let completed = false;

    /**
     * Фиксирует один исход ворот и снимает обработчик внешней отмены.
     * Диагностика берётся только из последней непустой строки stderr собственного скрипта.
     */
    function finish(code: number): void {
      if (completed) {
        return;
      }

      completed = true;
      signal.removeEventListener('abort', abort);

      resolve({
        code,
        lastLine: stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '',
      });
    }

    /**
     * Посылает сигнал только сохранённому процессу проверки маршрута.
     * Отменённая проверка сразу освобождает старт, даже если скрипт ещё завершает обработчик сигнала.
     */
    function abort(): void {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }

      finish(1);
    }

    try {
      child = spawnImpl('bash', [path.join(runtime.root, 'deploy/require-vpn.sh')], {
        env: runtime.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      finish(1);

      return;
    }

    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(code ?? 1));
    signal.addEventListener('abort', abort, { once: true });

    if (signal.aborted) {
      abort();
    }
  });
}

/**
 * Читает снимок службы с ограничением времени и подменяемой внешней командой.
 * Недоступный менеджер пользователя считается отсутствием сведений о службе.
 */
export async function readUnitState(signal: AbortSignal, execFileImpl = execFile): Promise<string> {
  if (signal.aborted) {
    return 'unavailable';
  }

  return new Promise((resolve) => {
    try {
      execFileImpl('systemctl', [
        '--user', 'show', 'grigdesk-server.service', '--property=ActiveState', '--value',
      ], {
        timeout: 5000,
        signal,
      }, (error, stdout) => {
        resolve(error ? 'unavailable' : String(stdout).trim());
      });
    } catch {
      resolve('unavailable');
    }
  });
}
