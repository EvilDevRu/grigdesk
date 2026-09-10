// Подготовка демо-данных профильным хуком.
//
// Это единственное место раздела, которое ПИШЕТ в данные стенда, поэтому гарды
// здесь плотнее, чем везде: хук доступен только на подготовленной демо-копии,
// поднятой человеком, объявленной профилем и подтверждённой отдельным решением.
//
// Прод и общий стенд не становятся демо-копией из-за названия цели «песочница»:
// среда объявляется профилем, владелец читается из реестра, а неизвестный владелец
// закрывает хук вовсе.
//
// Разрешение привязано к отпечатку стенда и ревизии самого скрипта. Смена любого
// из них делает его недействительным: подтверждали конкретный рецепт на конкретном
// стенде, а не «подготовку данных вообще».
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { ShowcaseError } from './errors.ts';
import type { ShowcaseResolvedScope } from './targets.ts';

const SCRIPT_NAME = 'seed.sh';
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const LOG_LIMIT = 16_000;

export interface SeedAvailability {
  available: boolean;
  reason: string;
  // Отпечаток рецепта: содержимое скрипта плюс отпечаток цели. По нему решение
  // человека привязано к тому, что он видел, а не к имени файла.
  recipeFingerprint: string;
  scriptPath: string;
}

export interface SeedDecision {
  id: string;
  recipeFingerprint: string;
  decidedAt: string;
}

export interface SeedOutcome {
  state: 'succeeded' | 'failed' | 'outcome_unknown';
  reason: string;
  log: string;
  dataRevision: string | null;
}

function fingerprintOf(scope: ShowcaseResolvedScope, script: string): string {
  return createHash('sha256')
    .update(`${scope.targetFingerprint}\n${script}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Доступен ли хук для этой цели. Каждый отказ называет СВОЮ причину: «недоступно»
 * без объяснения заставляет искать проблему не там, а условий тут пять и путать
 * их нельзя.
 */
export async function seedAvailability(
  scope: ShowcaseResolvedScope,
  contractDir: string,
): Promise<SeedAvailability> {
  const scriptPath = path.join(contractDir, SCRIPT_NAME);
  const blocked = (reason: string): SeedAvailability => ({
    available: false,
    reason,
    recipeFingerprint: '',
    scriptPath,
  });

  if (scope.environment !== 'isolated-demo') {
    return blocked('Подготовка данных возможна только на изолированной демо-копии.');
  }

  if (!scope.capabilities.includes('seed')) {
    return blocked('Профиль не объявил подготовку данных для этой цели.');
  }

  if (scope.ref.kind === 'project') {
    return blocked('Цель «проект» — не демо-копия: у неё нет своего жизненного цикла.');
  }

  const sandbox = scope.sandbox;

  if (!sandbox) {
    return blocked('Стенд цели не найден в реестре.');
  }

  if (sandbox.pipeline) {
    return blocked('Стендом владеет попытка конвейера: его данные разделу не принадлежат.');
  }

  if (sandbox.workspaceMode !== 'isolated') {
    return blocked('Стенд работает на общем рабочем дереве: подготовка данных затронет чужое.');
  }

  // Владельца объявляет сам стенд. Неизвестный владелец — не «наверное свой»:
  // это ровно тот случай, когда запись в данные делать нельзя.
  if (sandbox.standOwnership !== 'task') {
    return blocked(`Владелец стенда «${sandbox.standOwnership || 'неизвестен'}» не позволяет менять данные.`);
  }

  let script = '';

  try {
    script = await fs.readFile(scriptPath, 'utf8');
  } catch {
    return blocked('Профиль не положил showcase/seed.sh.');
  }

  return {
    available: true,
    reason: '',
    recipeFingerprint: fingerprintOf(scope, script),
    scriptPath,
  };
}

/**
 * Решение человека на конкретный рецепт. Одноразовое и привязанное к отпечатку:
 * повторный клик по кнопке не запускает второй прогон, а смена стенда или скрипта
 * требует нового подтверждения.
 */
export function createSeedDecision(recipeFingerprint: string): SeedDecision {
  return {
    id: randomBytes(6).toString('hex'),
    recipeFingerprint,
    decidedAt: new Date().toISOString(),
  };
}

export interface RunSeedInput {
  scope: ShowcaseResolvedScope;
  availability: SeedAvailability;
  decision: SeedDecision;
  workDir: string;
  deadlineMs?: number;
  signal?: AbortSignal;
}

/**
 * Запуск хука. Номер стенда уже проверен реестром, путь скрипта фиксирован
 * профилем, окружение — короткий allowlist. Данные сценария в командную строку не
 * попадают вовсе: подставлять туда текст, пришедший от модели или человека, значит
 * отдать оболочке чужую строку.
 */
export async function runSeed(input: RunSeedInput): Promise<SeedOutcome> {
  if (!input.availability.available) {
    throw new ShowcaseError('seed_unavailable', input.availability.reason, 409);
  }

  if (input.decision.recipeFingerprint !== input.availability.recipeFingerprint) {
    throw new ShowcaseError(
      'seed_decision_stale',
      'Стенд или сам рецепт изменились после подтверждения: нужно решение на новый рецепт.',
      409,
    );
  }

  const task = input.scope.sandbox?.task ?? '';

  if (!/^[1-9][0-9]{0,18}$/.test(task)) {
    throw new ShowcaseError('seed_unavailable', 'Номер стенда не читается.', 409);
  }

  await fs.mkdir(input.workDir, { recursive: true, mode: 0o700 });

  const logFile = path.join(input.workDir, 'seed.log');

  return new Promise<SeedOutcome>((resolve) => {
    const child = execFile(
      'bash',
      [input.availability.scriptPath, task],
      {
        cwd: path.dirname(input.availability.scriptPath),
        timeout: input.deadlineMs ?? DEFAULT_DEADLINE_MS,
        killSignal: 'SIGTERM',
        maxBuffer: 4 * 1024 * 1024,
        signal: input.signal,
        // Окружение — короткий явный список. Ключи, токены и адреса поставщиков
        // хуку не нужны, а унаследованное окружение сервера содержит их все.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          SHOWCASE_TASK: task,
          SHOWCASE_PROFILE: input.scope.profile,
        },
      },
      async (error, stdout, stderr) => {
        const log = `${stdout}\n${stderr}`.slice(0, LOG_LIMIT);

        await fs.writeFile(logFile, log, { encoding: 'utf8', mode: 0o600 }).catch(() => null);

        if (!error) {
          resolve({
            state: 'succeeded',
            reason: 'Данные подготовлены.',
            log,
            // Новую ревизию данных объявляет профиль своим выводом; если он молчит,
            // её ставит сервер — но фактом обновления считается сам успешный прогон.
            dataRevision: readDataRevision(stdout) ?? randomBytes(6).toString('hex'),
          });

          return;
        }

        // Прерванный по сроку или сигналу хук мог успеть изменить часть данных.
        // Такой исход НЕ повторяется автоматически: повтор половины рецепта
        // способен испортить больше, чем оборванный первый прогон.
        const interrupted = (error as { killed?: boolean }).killed === true
          || (error as { code?: string }).code === 'ABORT_ERR';

        resolve({
          state: interrupted ? 'outcome_unknown' : 'failed',
          reason: interrupted
            ? 'Подготовка оборвана: что успело измениться — неизвестно, повтор остаётся за человеком.'
            : 'Скрипт подготовки завершился с ошибкой.',
          log,
          dataRevision: null,
        });
      },
    );

    child.on('error', () => null);
  });
}

/**
 * Ревизия данных из вывода хука. Профиль объявляет её строкой, чтобы кокпит мог
 * отличить одну подготовку от другой; без неё раздел ставит свою и не обещает,
 * что понял состояние данных.
 */
export function readDataRevision(stdout: string): string | null {
  const match = /^SHOWCASE_DATA_REVISION=(\S+)$/m.exec(stdout);

  return match?.[1] ?? null;
}
