import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
}

/**
 * Недоступный файл трактуется как отсутствие необязательного источника данных.
 * Caller не получает ни исключения, ни содержимого других файлов окружения.
 */
export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Разрешает корень копии через файловую систему, включая символические ссылки.
 * Остальные пути CLI строятся от этого единственного канонического корня.
 */
export async function realPath(file: string): Promise<string> {
  return realpath(file);
}

/**
 * Возвращает только текст цели ссылки, не читая содержимое файла по ссылке.
 * Отсутствующая либо недоступная блокировка окна не прерывает снимок статуса.
 */
export async function readLink(file: string): Promise<string | null> {
  try {
    return await readlink(file);
  } catch {
    return null;
  }
}

/**
 * Наличие установленного окна требует обычного исполняемого файла.
 * Ошибка доступа означает отсутствие пригодной установки, без запуска приложения.
 */
export async function executable(file: string): Promise<boolean> {
  try {
    const info = await stat(file);

    await access(file, fsConstants.X_OK);

    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Сигнал ноль проверяет существование PID и никогда не завершает процесс.
 * EPERM подтверждает живой чужой процесс, ESRCH и прочие ошибки дают отсутствие.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal ? 128 + osConstants.signals[signal] : 1);
}

/**
 * Запускает точные argv без shell и ограничивает время отдельного внешнего чтения/действия.
 * Ошибка запуска, stderr и таймаут возвращаются как данные, а не скрывают причину отказа.
 */
export function run(command: string, args: readonly string[], timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let missing = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      missing = error.code === 'ENOENT';
      stderr = error.message;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: exitCode(code, signal),
        stdout,
        stderr,
        missing,
        timedOut,
      });
    });
  });
}

/**
 * Журнал подключается к терминалу без буфера и без таймаута.
 * SIGINT получает ребёнок; родитель ждёт его код и затем снимает свой listener.
 */
export function runAttached(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const ignore = () => {};

    process.on('SIGINT', ignore);

    const child = spawn(command, [...args], { stdio: 'inherit' });

    child.once('error', (error) => {
      process.removeListener('SIGINT', ignore);
      console.error(error.message);
      resolve(1);
    });
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', ignore);
      resolve(exitCode(code, signal));
    });
  });
}

/**
 * Отвязанный запуск окна завершается только после подтверждения spawn либо ошибки.
 * Потоки закрыты, а unref освобождает CLI, сохраняя жизненный цикл самого приложения.
 */
export function spawnDetached(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      env,
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Сетевое чтение данных имеет общий срок, включая разбор тела JSON.
 * Redirect и любые отказы возвращают null, содержимое токена не попадает в сообщения.
 */
export async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });

    if (response.status !== 200) {
      return null;
    }

    const body: unknown = await response.json();

    return controller.signal.aborted ? null : body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
