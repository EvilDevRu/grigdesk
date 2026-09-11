// Запуск отсоединённого исполнителя записи и наблюдение за ним.
//
// Процесс запускается открепле́нным от сервера намеренно: правка репозитория и
// перезапуск кокпита не должны убивать идущую запись. Взамен требуется честная
// проверка живости — снимок identity процесса (время старта и командная строка),
// потому что номер процесса после перезагрузки достаётся кому угодно.
//
// Сервер читает журнал попытки, но не пишет в него; worker пишет журнал, но не
// трогает запись ролика. Пересечения нет ни в одну сторону.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureProcessIdentity } from '../../speech/modelJobsProcess.ts';
import { ShowcaseError } from '../errors.ts';
import type { JobIdentity } from '../jobs.ts';

const WORKER_SCRIPT = fileURLToPath(new URL('../../../../scripts/showcaseWorker.mts', import.meta.url));

export interface WorkerLaunchInput {
  workDir: string;
  task: Record<string, unknown>;
  nodeBin?: string;
  // Открытые дескрипторы kernel-lock дублируются начиная с fd 3. Worker их не
  // трогает: само присутствие копии удерживает flock до завершения процесса.
  inheritedFds?: number[];
  // Исполнитель по умолчанию — запись браузера. Установка локального голоса
  // использует ту же машинерию отсоединённого процесса, но свой скрипт, поэтому
  // метка для сверки identity приходит вместе с ним.
  script?: { file: string; marker: string };
}

export interface WorkerHandle {
  attemptId: string;
  identity: JobIdentity;
  workDir: string;
}

export interface WorkerProgressLine {
  attemptId: string;
  sequence: number;
  state: string;
  label: string;
  index?: number;
  total?: number;
}

export interface WorkerResult {
  attemptId: string;
  state: 'succeeded' | 'failed';
  error?: string;
  scenes: {
    sceneId: string;
    attempts: number;
    rawPath: string;
    readyOffsetMs: number;
    recordedMs: number;
    durationMs: number;
    blockedRequests: number;
    // Ожидания затишья сети, упёршиеся в предел: подсказка, почему кадр сцены
    // мог не дождаться данных.
    unsettled?: number;
  }[];
}

/**
 * Запускает исполнителя и возвращает его снимок identity. Метка попытки попадает
 * в командную строку: по ней сверка отличает СВОЙ процесс от постороннего, занявшего
 * тот же номер, и от исполнителя другой попытки того же задания.
 */
export async function launchWorker(input: WorkerLaunchInput): Promise<WorkerHandle> {
  const attemptId = randomBytes(6).toString('hex');
  const workDir = path.join(input.workDir, attemptId);

  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

  const taskFile = path.join(workDir, 'task.json');

  await fs.writeFile(
    taskFile,
    `${JSON.stringify({ ...input.task, attemptId, workDir }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  const logFile = path.join(workDir, 'worker.log');
  const log = await fs.open(logFile, 'a', 0o600);
  const script = input.script ?? { file: WORKER_SCRIPT, marker: 'showcaseWorker' };
  const child = spawn(
    input.nodeBin ?? process.execPath,
    [script.file, taskFile],
    {
      detached: true,
      stdio: ['ignore', log.fd, log.fd, ...(input.inheritedFds ?? [])],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        // Установка голоса ходит в сеть, и за шлюзом без этих переменных она
        // молча упрётся в таймаут. Записи они не мешают: браузер ходит только
        // через свой прокси и системных переменных не читает.
        ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
        ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
        ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
        // Метка попытки видна в командной строке процесса, поэтому её же читает
        // сверка. Ни адресов, ни ключей исполнителю через окружение не передаётся.
        COCKPIT_SHOWCASE_ATTEMPT: attemptId,
      },
    },
  );

  child.unref();
  await log.close();

  if (!child.pid) {
    throw new ShowcaseError('worker_failed', 'Исполнитель записи не запустился.', 500);
  }

  const identity = captureProcessIdentity(child.pid, {
    script: script.marker,
    nonce: attemptId,
  }) as JobIdentity | null;

  return {
    attemptId,
    workDir,
    identity: identity ?? { pid: child.pid, starttime: null, cmdline: null },
  };
}

/**
 * Новые строки журнала попытки. Читается весь файл и отбрасывается уже виденное:
 * журнал одной записи короткий, а следить за смещением в файле, который пишет
 * чужой процесс, — лишний способ ошибиться на перезапуске.
 */
export async function readProgressSince(
  workDir: string,
  seenSequence: number,
): Promise<WorkerProgressLine[]> {
  let text = '';

  try {
    text = await fs.readFile(path.join(workDir, 'progress.jsonl'), 'utf8');
  } catch {
    return [];
  }

  const lines: WorkerProgressLine[] = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as WorkerProgressLine;

      if (typeof parsed.sequence === 'number' && parsed.sequence > seenSequence) {
        lines.push(parsed);
      }
    } catch {
      // Недописанная последняя строка — обычное дело для журнала живого процесса.
    }
  }

  return lines;
}

/**
 * Итог попытки, если он уже записан. Отсутствие файла означает «ещё идёт» и от
 * «упал молча» отличается проверкой живости процесса, а не догадкой по времени.
 */
export async function readWorkerResult(workDir: string): Promise<WorkerResult | null> {
  try {
    const text = await fs.readFile(path.join(workDir, 'result.json'), 'utf8');
    const parsed = JSON.parse(text) as WorkerResult;

    return parsed.state === 'succeeded' || parsed.state === 'failed' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Остановка дерева процессов исполнителя. Сигнал уходит группе: браузер и его
 * дочерние процессы иначе переживают смерть родителя и держат цель занятой.
 */
export function stopWorker(identity: JobIdentity): boolean {
  if (!identity.pid) {
    return false;
  }

  try {
    process.kill(-identity.pid, 'SIGTERM');

    return true;
  } catch {
    try {
      process.kill(identity.pid, 'SIGTERM');

      return true;
    } catch {
      return false;
    }
  }
}
