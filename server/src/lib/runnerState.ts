// Представление multi-AI маршрутизации для API GrigDesk.
//
// Источник истины не дублируется: профиль читается из того же
// profiles/<profile>/runners.env, а task override и фактический результат —
// из t<task>.pipeline. Порядок приоритетов повторяет engine/lib/routing.sh.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { normalizedMetaUsage } from './metaUsage.ts';
import type { MetaEnv, MetaUsage } from './metaUsage.ts';
import { parsePipeline } from './pipelineParse.ts';
import { GLM_FACTORY_MODELS } from './glm/factoryCatalog.ts';
import { openRunDirectory, readRunFile, readRunnerFailure } from './runnerArtifacts.ts';
import { runnerFailureDetail } from './runnerFailure.ts';
import { runnerModelName } from './runnerModel.ts';

// Реестр задачи и runners.env профиля читаются одинаково: плоские строковые пары.
export type RunnerRegistry = Record<string, string | undefined>;

// Цепочка исполнителей и откуда она взялась: приоритет источника решает конфликт.
export interface RunnerPolicy {
  primary: string | null;
  failover: string[];
  chain: string[];
  source: string;
}

// Требование к модели: точное имя либо семейство с версией и вариантом.
export interface ModelPolicy {
  exact: string | null;
  label?: string | null;
  family: string | null;
  version: string | null;
  variant: string | null;
  effort: string | null;
}

// Состояние маршрутизации этапа: цепочка, факт и телеметрия последнего запуска.
export interface RunnerState extends RunnerPolicy {
  actual: string | null;
  family: string | null;
  model: string | null;
  reason: string | null;
  planLevel: string | null;
  catalogRevision: string | null;
  switched: boolean;
  models: Record<string, ModelPolicy | null>;
}

// Legacy-числа попытки рядом с точными строками: старый бандл читает только их.
export interface RunAttemptTokens {
  in: number | null;
  out: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  costUsd: number | null;
  exact: MetaUsage;
}

// Один реально стартовавший процесс этапа по его meta.env.
export interface RunnerAttempt {
  id: string;
  epoch: number | null;
  runner: string | null;
  model: string | null;
  effort: string | null;
  reason: string | null;
  result: string | null;
  rc: number | null;
  source: string | null;
  tokens: RunAttemptTokens | null;
  failureDetail?: string;
}

// Фактическое рабочее время процессов попытки маршрута.
export interface RunnerWorkTime {
  workSec: number;
  runningSinceMs: number | null;
  completedRuns: number;
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const STAGE_ID = /^[A-Z][A-Z0-9_]*$/;
const RUN_ID = /^[A-Za-z0-9._-]+$/;

function uniqueProviders(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const id = String(value || '').trim();
    if (PROVIDER_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function splitChain(value: string | undefined): string[] {
  return uniqueProviders(String(value || '').split(','));
}

function policy(
  primaryValue: string | undefined,
  failoverValue: string | undefined,
  source: string,
): RunnerPolicy {
  const chain = uniqueProviders([...splitChain(primaryValue), ...splitChain(failoverValue)]);
  return {
    primary: chain[0] || null,
    failover: chain.slice(1),
    chain,
    source,
  };
}

/**
 * Предварительная политика повторяет приоритет этапа над профилем, не меняя настройки запуска.
 * Служебному семейству GLM добавляем подпись из каталога, которую UI может показать до первого хода.
 */
function modelPolicy(
  profileConfig: RunnerRegistry,
  stage: string,
  provider: string,
): ModelPolicy | null {
  const providerKey = String(provider || '').toUpperCase().replace(/-/g, '_');
  if (!providerKey || !STAGE_ID.test(stage)) return null;
  const value = (suffix: string) => profileConfig[`MODEL_${stage}_${providerKey}_${suffix}`]
    || profileConfig[`MODEL_DEFAULT_${providerKey}_${suffix}`]
    || null;
  const exact = runnerModelName(value('EXACT'));
  const family = value('FAMILY') || (provider === 'glm' ? 'default' : null);
  if (!exact && !family) return null;

  return {
    exact,
    ...(provider === 'glm' && family === 'default'
      ? { label: exact || runnerModelName(GLM_FACTORY_MODELS[0]?.id) } : {}),
    family,
    version: value('VERSION') || (family ? 'latest' : null),
    variant: value('VARIANT') || (family ? 'auto' : null),
    effort: value('EFFORT'),
  };
}

/** Синхронно читает небольшой canonical runners.env; отсутствующий/невалидный → {}. */
export function loadRunnerConfig(profilesDir: string, profile: string): Record<string, string> {
  if (!PROFILE_ID.test(String(profile || ''))) return {};
  try {
    return parsePipeline(fs.readFileSync(
      path.join(profilesDir, profile, 'runners.env'),
      'utf8',
    ));
  } catch {
    return {};
  }
}

/** Проектная цепочка без stage/task override — для шапки карточки конвейера. */
export function resolveProjectRunnerState(profileConfig: RunnerRegistry): RunnerPolicy {
  return policy(
    profileConfig.PROJECT_RUNNER_PRIMARY,
    profileConfig.PROJECT_RUNNER_FAILOVER,
    'profile-project',
  );
}

/**
 * Цепочка, runtime-телеметрия и подписи этапа собираются на серверной границе DTO.
 * Последняя GLM-попытка уточняет модель до старта, не подменяя фактическую модель реестра.
 */
export function resolveRunnerState(
  profileConfig: RunnerRegistry,
  registry: RunnerRegistry,
  stage: string,
  attempts: RunnerAttempt[] = [],
): RunnerState {
  const key = STAGE_ID.test(String(stage || '')) ? stage : '';
  let resolved: RunnerPolicy;

  const taskStage = key ? splitChain(registry[`RUNNER_OVERRIDE_STAGE_${key}`]) : [];
  if (taskStage.length) {
    resolved = policy(taskStage[0], taskStage.slice(1).join(','), 'task-stage');
  } else if (splitChain(registry.RUNNER_OVERRIDE_PRIMARY).length) {
    resolved = policy(
      registry.RUNNER_OVERRIDE_PRIMARY,
      registry.RUNNER_OVERRIDE_FAILOVER,
      'task',
    );
  } else if (key && splitChain(profileConfig[`STAGE_${key}_PRIMARY`]).length) {
    resolved = policy(
      profileConfig[`STAGE_${key}_PRIMARY`],
      profileConfig[`STAGE_${key}_FAILOVER`],
      'profile-stage',
    );
  } else {
    resolved = resolveProjectRunnerState(profileConfig);
  }

  const actual = key && PROVIDER_ID.test(registry[`RUNNER_ACTUAL_${key}`] || '')
    ? registry[`RUNNER_ACTUAL_${key}`] ?? null
    : null;
  const models = Object.fromEntries(resolved.chain.map((provider) => [
    provider,
    modelPolicy(profileConfig, key, provider),
  ]));

  const glmPolicy = models.glm;
  const latestGlm = attempts.findLast((attempt) => attempt.runner === 'glm' && attempt.model);

  if (glmPolicy && latestGlm?.model) {
    glmPolicy.label = latestGlm.model;
  }

  return {
    ...resolved,
    actual,
    family: key ? registry[`MODEL_FAMILY_${key}`] || null : null,
    model: runnerModelName(key ? registry[`MODEL_ACTUAL_${key}`] : null),
    reason: key ? registry[`RUNNER_REASON_${key}`] || null : null,
    planLevel: key ? registry[`PLAN_LEVEL_${key}`] || null : null,
    catalogRevision: key ? registry[`CATALOG_REVISION_${key}`] || null : null,
    switched: !!(actual && resolved.primary && actual !== resolved.primary),
    models,
  };
}

/**
 * Пока резервный runner ещё работает, dispatcher не успел записать финальную
 * RUNNER_REASON_<STAGE>. Причину берём из последней завершённой попытки другого
 * provider-а. Резерв может сам перезапуститься после missing status; ближайшая
 * попытка тогда тоже будет резервной и не должна скрыть исходную причину switch.
 */
export function activeRunnerReason(
  runner: RunnerState | null | undefined,
  attempts: RunnerAttempt[] = [],
): string | null {
  const active = attempts.at(-1);
  if (!runner?.switched || !active || active.runner !== runner.actual || active.result != null) {
    return runner?.reason || null;
  }
  const completed = attempts.slice(0, -1).filter((attempt) => attempt.result != null);
  const previous = completed.findLast((attempt) => attempt.runner !== runner.actual)
    || completed.at(-1);
  const reasons: Record<string, string | undefined> = {
    limited: 'fallback_limit',
    provider_unavailable: 'fallback_provider_unavailable',
    manual_switch: 'manual_switch',
  };
  return active.reason || reasons[String(previous?.result)] || runner.reason || null;
}

function legacyNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

/**
 * Schema-2 блок `meta.env` уже разобран в `lib/meta-usage.js`. Здесь нет второй
 * token/cost арифметики: exact strings сохраняются для нового web, а прежние number
 * поля остаются только как bounded rolling-upgrade fallback для старого bundle.
 */
function runAttemptTokens(meta: MetaEnv): RunAttemptTokens | null {
  const exact = normalizedMetaUsage(meta);
  if (exact === null) return null;
  return {
    in: legacyNumber(exact.in),
    out: legacyNumber(exact.out),
    cacheRead: legacyNumber(exact.cacheRead),
    cacheWrite: legacyNumber(exact.cacheWrite),
    costUsd: legacyNumber(exact.costUsd),
    exact,
  };
}

/**
 * Причина провайдера поясняет завершившийся отказ: успех, таймаут и остановка её не наследуют.
 * Старому запуску без mirror читаем ограниченный хвост его собственного журнала через retained FD.
 */
async function attemptFailure(
  stateDir: string,
  task: string | number,
  stage: string,
  id: string,
  meta: MetaEnv,
): Promise<string | null> {
  if (!/^-?\d+$/u.test(meta.RC || '')
    || [0, 124, 130, 143].includes(Number(meta.RC))
    || !meta.RESULT_CLASS || ['ok', 'timeout', 'manual_switch'].includes(meta.RESULT_CLASS)) {
    return null;
  }

  try {
    const directory = await openRunDirectory(stateDir, ['logs', 'runs', `t${task}`, stage, id]);

    try {
      const current = parsePipeline(await readRunFile(directory, 'meta.env'));

      if (['RUNNER', 'EPOCH', 'RC', 'RESULT_CLASS'].some((key) => current[key] !== meta[key])) {
        return null;
      }

      const failure = await readRunnerFailure(directory, current);

      return runnerFailureDetail(failure);
    } finally {
      await directory.close();
    }
  } catch {
    return null;
  }
}

/**
 * История реально стартовавших процессов этапа. meta.env пишет runner-launcher;
 * это диагностические данные, поэтому битый/исчезнувший run не ломает весь граф.
 */
export async function readRunnerAttempts(
  stateDir: string,
  task: string | number,
  stage: string,
): Promise<RunnerAttempt[]> {
  if (!/^\d+$/.test(String(task || '')) || !STAGE_ID.test(String(stage || ''))) return [];
  const root = path.join(stateDir, 'logs', 'runs', `t${task}`, stage);
  let ids: string[];
  try {
    ids = await fsp.readdir(root);
  } catch {
    return [];
  }
  const attempts: RunnerAttempt[] = [];
  const metadata = new Map<string, MetaEnv>();

  await Promise.all(ids.map(async (id) => {
    if (!RUN_ID.test(id)) return;

    try {
      const meta = parsePipeline(await fsp.readFile(path.join(root, id, 'meta.env'), 'utf8'));

      metadata.set(id, meta);
      attempts.push({
        id,
        epoch: /^\d+$/.test(meta.EPOCH || '') ? Number(meta.EPOCH) : null,
        runner: PROVIDER_ID.test(meta.RUNNER || '') ? meta.RUNNER ?? null : null,
        model: runnerModelName(meta.RESOLVED_MODEL || meta.MODEL),
        effort: meta.EFFORT ?? null,
        reason: meta.ROUTE_REASON || null,
        result: meta.RESULT_CLASS || null,
        rc: /^-?\d+$/.test(meta.RC || '') ? Number(meta.RC) : null,
        source: meta.SOURCE || null,
        tokens: runAttemptTokens(meta),
      });
    } catch { /* незавершённый запуск ещё мог не записать meta.env */ }
  }));
  attempts.sort((a, b) => (a.epoch ?? Number.MAX_SAFE_INTEGER) - (b.epoch ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id));

  const recent = attempts.slice(-20);

  // Старые журналы читаются только для видимых попыток, а не для всей истории этапа.
  await Promise.all(recent.map(async (attempt) => {
    const detail = await attemptFailure(stateDir, task, stage, attempt.id, metadata.get(attempt.id)!);

    if (detail) {
      attempt.failureDetail = detail;
    }
  }));

  return recent;
}

/**
 * Фактическое время процессов runner-а для текущей route-attempt.
 *
 * Начало запуска — birthtime его каталога, конец завершённого — mtime финального
 * meta.env. В отличие от route ledger это не расстояние между соседними событиями:
 * простой после падения оркестратора не приклеивается к следующему этапу. Каталоги
 * старых попыток той же задачи отсекаются по createdAt trusted attempt.
 */
export async function readRunnerWorkTime(
  stateDir: string,
  task: string | number,
  stages: string[],
  { sinceMs = 0, activeRuns = {} }: {
    sinceMs?: number;
    activeRuns?: Record<string, string | undefined>;
  } = {},
): Promise<RunnerWorkTime | null> {
  const taskId = String(task || '');
  if (!/^\d+$/.test(taskId) || !Array.isArray(stages)) return null;
  const stageIds = [...new Set(stages.filter((stage) => STAGE_ID.test(String(stage || ''))))];
  if (!stageIds.length) return null;

  const lowerBound = Number.isFinite(Number(sinceMs)) && Number(sinceMs) > 0
    ? Number(sinceMs)
    : 0;
  let completedMs = 0;
  let completedRuns = 0;
  let runningSinceMs: number | null = null;

  await Promise.all(stageIds.map(async (stage) => {
    const root = path.join(stateDir, 'logs', 'runs', `t${taskId}`, stage);
    let ids: string[];
    try { ids = await fsp.readdir(root); } catch { return; }
    await Promise.all(ids.map(async (id) => {
      if (!RUN_ID.test(id)) return;
      const runDir = path.join(root, id);
      let runStat: Stats;
      try { runStat = await fsp.lstat(runDir); } catch { return; }
      const startedAtMs = Number(runStat.birthtimeMs);
      if (!runStat.isDirectory() || runStat.isSymbolicLink()
          || !Number.isFinite(startedAtMs) || startedAtMs <= 0 || startedAtMs < lowerBound) return;

      const active = activeRuns?.[stage] === id;
      let meta: Record<string, string>;
      let metaStat: Stats;
      try {
        const metaPath = path.join(runDir, 'meta.env');
        const statValue = await fsp.lstat(metaPath);
        if (!statValue.isFile() || statValue.isSymbolicLink()) return;
        const text = await fsp.readFile(metaPath, 'utf8');
        meta = parsePipeline(text);
        metaStat = statValue;
      } catch {
        // run-state успевает назвать active run до первой записи meta.env.
        if (active && (runningSinceMs === null || startedAtMs < runningSinceMs)) {
          runningSinceMs = startedAtMs;
        }
        return;
      }

      // Новые meta несут полную identity; старые диагностические записи могли
      // обходиться без TASK/STAGE/RUN_ID, поэтому проверяем поля только когда они есть.
      if ((meta.TASK && meta.TASK !== taskId)
          || (meta.STAGE && meta.STAGE !== stage)
          || (meta.RUN_ID && meta.RUN_ID !== id)) return;

      if (meta.RESULT_CLASS) {
        const finishedAtMs = Number(metaStat.mtimeMs);
        if (Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs) {
          completedMs += finishedAtMs - startedAtMs;
          completedRuns += 1;
        }
      } else if (active && (runningSinceMs === null || startedAtMs < runningSinceMs)) {
        runningSinceMs = startedAtMs;
      }
    }));
  }));

  if (!completedRuns && runningSinceMs === null) return null;
  return {
    workSec: Math.floor(completedMs / 1000),
    runningSinceMs,
    completedRuns,
  };
}
