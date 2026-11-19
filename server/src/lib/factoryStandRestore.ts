// Подъём стенда задачи перед продолжением попытки конвейера.
//
// Стенд isolated-профиля принадлежит задаче, но его процессы живут не дольше машины:
// после перезагрузки worktree, реестр песочницы и папка данных на месте, а сервисов нет.
// Движок на resume стенд только проверяет (`profile_stand_alive`) и при мёртвом выходит
// кодом 73 через десяток секунд после «Продолжить». Поэтому GrigDesk до запуска движка
// поднимает стенд опциональным хуком профиля `profile_stand_start`.
// Общий (shared) стенд чужой: его GrigDesk не проверяет и не запускает никогда.
import { execFile } from 'node:child_process';
import path from 'node:path';

import { PROFILE_RE } from './profiles.ts';
import { prepareFactoryRouteLaunch, type FactoryRouteLaunchPaths } from './factoryLaunch.ts';
import { macEngineDependency, type MacEngineTool } from './factoryDarwinRuntime.ts';

import type { ExecFileException } from 'node:child_process';

// Корни, без которых профиль не прочитать и реестр песочницы не найти.
export interface StandRestoreConfig extends Partial<FactoryRouteLaunchPaths> {
  profilesDir: string;
  factoryHome: string;
  stateDir: string;
}

// Что известно о стенде из закреплённой попытки и сколько ждать подъёма.
export interface StandRestoreRequest {
  profile: string;
  task: string;
  standOwnership: string;
  attempt?: string;
  timeoutMs?: number;
}

// `skipped` — проверка не применима: стенд не принадлежит задаче, профиль не объявил
// хуки или не читается. Решение тогда остаётся за движком, как до появления хука.
export type StandRestoreResult =
  | { ok: true; outcome: 'alive' | 'started' | 'skipped' }
  | {
    ok: false;
    message: string;
    tool?: MacEngineTool;
  };

const TASK_RE = /^[1-9][0-9]{0,18}$/;
// stand.sh grigdesk ждёт ответа стенда до 90 с; запас — на проверки до и после подъёма.
const DEFAULT_TIMEOUT_MS = 180_000;
// Срок держит coreutils `timeout`: он гасит всю группу процессов хука. Таймер execFile
// убил бы только bash, а зависший потомок с открытым stderr держал бы ответ дальше.
const KILL_AFTER_SECONDS = 5;
const EXEC_BACKSTOP_MS = 15_000;
const TIMEOUT_EXIT_CODES = new Set([124, 137]);
const MESSAGE_LIMIT = 500;
const OUTCOMES = new Set(['alive', 'started', 'skipped']);

// profile.sh — trusted executable configuration, которую всё равно source-ит движок.
// Аргументы позиционные. Вывод хуков уходит в stderr: stdout несёт только итог проверки.
// Код 2 — хук отработал без ошибки, но стенд так и не ответил.
const RESTORE_SCRIPT = String.raw`
source "$1" >/dev/null 2>&1 || { printf 'skipped\n'; exit 0; }
if ! declare -F profile_stand_alive >/dev/null || ! declare -F profile_stand_start >/dev/null; then
  printf 'skipped\n'
  exit 0
fi
if profile_stand_alive "$2" >&2; then
  printf 'alive\n'
  exit 0
fi
profile_stand_start "$2" >&2 || exit 1
profile_stand_alive "$2" >&2 || exit 2
printf 'started\n'
`;

/**
 * Собирает причину отказа для человека: что случилось и последние строки вывода хука.
 * Текст уходит в ответ «Продолжить» и в карточку, поэтому он короткий и без stack trace.
 */
function failureMessage(error: ExecFileException, stderr: string, timeoutMs: number): string {
  const tail = String(stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ');
  let reason = 'хук подъёма профиля завершился с ошибкой';

  if (error.killed || TIMEOUT_EXIT_CODES.has(Number(error.code))) {
    reason = `подъём не уложился в ${Math.round(timeoutMs / 1000)} с`;
  } else if (error.code === 2) {
    reason = 'после подъёма стенд не отвечает';
  }

  return `стенд задачи не поднялся: ${reason}${tail ? ` — ${tail}` : ''}`.slice(0, MESSAGE_LIMIT);
}

/**
 * Проверяет стенд задачи и при необходимости поднимает его хуком профиля.
 * Стенд, который не принадлежит задаче, профиль без хуков и нечитаемый профиль дают
 * `skipped`: движок тогда сам решит, как раньше. Отказ подъёма возвращается текстом
 * с хвостом вывода профиля — продолжать прогон на мёртвом стенде бессмысленно.
 */
export async function restoreTaskStand(
  config: StandRestoreConfig,
  { profile, task, attempt, standOwnership, timeoutMs = DEFAULT_TIMEOUT_MS }: StandRestoreRequest,
): Promise<StandRestoreResult> {
  if (standOwnership !== 'task') {
    return { ok: true, outcome: 'skipped' };
  }
  if (!PROFILE_RE.test(String(profile || '')) || !TASK_RE.test(String(task || ''))) {
    return { ok: false, message: 'стенд задачи не поднялся: профиль или номер задачи неверного формата' };
  }

  const profileFile = path.join(config.profilesDir, profile, 'profile.sh');
  let runtimeEnv: Record<string, string> = {};

  if (process.platform === 'darwin') {
    if (!config.rootDir || !config.factoryControlDir || !config.factoryBin
      || !config.factoryConfigRoot || !attempt) {
      return { ok: false, message: 'стенд задачи не поднялся: нет закреплённого runtime' };
    }

    try {
      const selected = await prepareFactoryRouteLaunch(config as FactoryRouteLaunchPaths,
        [task, 'check', '--profile', profile, '--attempt', attempt]);

      config = selected.config;
      runtimeEnv = selected.config.runtimeHostEnv!;
    } catch (error) {
      const tool = macEngineDependency(error);
      const message = tool ? `Для конвейера macOS требуется «${tool}».`
        : 'Закреплённый runtime стенда недоступен.';

      return {
        ok: false,
        message,
        ...(tool ? { tool } : {}),
      };
    }
  }

  return new Promise<StandRestoreResult>((resolve) => {
    execFile(runtimeEnv.FACTORY_DARWIN_TIMEOUT ?? 'timeout',
      [`--kill-after=${KILL_AFTER_SECONDS}`, String(timeoutMs / 1000),
      runtimeEnv.FACTORY_DARWIN_BASH ?? 'bash', '--noprofile', '--norc', '-c', RESTORE_SCRIPT,
      'factory-stand-restore', profileFile, task], {
      env: {
        ...process.env,
        FACTORY_HOME: config.factoryHome,
        FACTORY_PROFILES_DIR: config.profilesDir,
        STATE_DIR: config.stateDir,
        ...runtimeEnv,
      },
      timeout: timeoutMs + KILL_AFTER_SECONDS * 1000 + EXEC_BACKSTOP_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, message: failureMessage(error, stderr, timeoutMs) });

        return;
      }

      const outcome = String(stdout || '').trim().split('\n').at(-1) || '';

      if (OUTCOMES.has(outcome)) {
        resolve({ ok: true, outcome: outcome as 'alive' | 'started' | 'skipped' });
      } else {
        resolve({ ok: false, message: 'стенд задачи не поднялся: профиль вернул неизвестный итог' });
      }
    });
  });
}
