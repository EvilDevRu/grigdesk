import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Выбирает выпускной файл независимо от cwd команды npm.
 * Отсутствие сборки считается отказом с понятной подсказкой, а не skip.
 */
export function seaBinary() {
  const file = process.env.GRIGDESK_RELAY_TEST_BINARY ??
    fileURLToPath(new URL('../../../bin/grigdesk-relay', import.meta.url));

  assert.ok(path.isAbsolute(file), 'GRIGDESK_RELAY_TEST_BINARY должен быть абсолютным');
  assert.ok(existsSync(file), 'Нет готового файла: сначала tools/relay build');

  return file;
}

/**
 * Запускает проверки на копии с пробелами в пути, без соседнего Node и исходников.
 * Уборка удаляет только уникальный каталог этого файла тестов.
 */
export async function copyBinary(t) {
  const source = seaBinary();
  const directory = await mkdtemp(path.join(tmpdir(), 'grigdesk relay sea-'));
  const destination = path.join(directory, 'папка с пробелами', 'grigdesk-relay');

  t.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));
  await mkdir(path.dirname(destination));
  await copyFile(source, destination);
  await chmod(destination, 0o755);

  return destination;
}

/**
 * Получает только непосредственных детей известного собственного процесса.
 * Linux хранит children отдельно для каждого потока, поэтому объединяем все task.
 */
export async function childPids(pid) {
  const result = new Set();
  const task = `/proc/${pid}/task`;

  try {
    for (const thread of await readdir(task)) {
      try {
        const children = await readFile(path.join(task, thread, 'children'), 'utf8');

        for (const value of children.trim().split(/\s+/).filter(Boolean)) {
          result.add(Number(value));
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  return [...result];
}

/**
 * Посылает сигнал только заранее сохранённому собственному PID.
 * Исчезнувший процесс уже удовлетворяет очистке и не считается ошибкой.
 */
export function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Проверяет существование PID только собственной рабочей части.
 * Отсутствие процесса — ожидаемый результат, прочие ошибки пробрасываются.
 */
export function pidExists(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }

    return false;
  }
}

/**
 * Ограничивает ожидание наблюдаемого состояния без бесконечного polling.
 * Ошибка содержит только техническое описание условия, без настроек процесса.
 */
export async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await pause(30);
  }

  assert.fail('Истёк срок ожидания состояния собственного процесса');
}

/**
 * Резервирует свободный loopback-порт средствами ОС, затем освобождает его.
 * Тесты не используют порты живого посредника и GrigDesk.
 */
export async function freePort() {
  const server = net.createServer();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const port = server.address().port;

  await new Promise((resolve) => server.close(resolve));

  return port;
}

/**
 * Проверяет возможность снова слушать именно порт завершённой фикстуры.
 * EADDRINUSE означает незакрытый listener, остальные ошибки не скрываются.
 */
export function portIsFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * Запускает копию с пустым PATH и только синтетическими настройками теста.
 * Очистка ограничена родителем и детьми, полученными из его собственного /proc.
 */
export async function startRelay(t, { binary, env }) {
  const child = spawn(binary, [], {
    cwd: path.dirname(binary),
    env: {
      PATH: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = {
    stdout: '',
    stderr: '',
  };
  const exited = new Promise((resolve, reject) => {
    child.once('close', (code, signal) => resolve({
      code,
      signal,
    }));
    child.once('error', reject);
  });
  const owned = new Set();

  child.stdout.on('data', (chunk) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk.toString();
  });
  t.after(async () => {
    for (const pid of await childPids(child.pid)) {
      owned.add(pid);
    }

    child.kill('SIGTERM');

    let timer;

    await Promise.race([
      exited.catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
    clearTimeout(timer);
    child.kill('SIGKILL');

    for (const pid of owned) {
      signalPid(pid, 'SIGCONT');
      signalPid(pid, 'SIGKILL');
    }

    await exited.catch(() => {});
  });
  await waitFor(() => {
    assert.equal(child.exitCode, null, 'посредник завершился до listening');

    return output.stdout.includes('"ev":"listening"');
  }, 10000);

  for (const pid of await childPids(child.pid)) {
    owned.add(pid);
  }

  return {
    child,
    pid: child.pid,
    exited,
    output,
  };
}
