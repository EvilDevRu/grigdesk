// Представление multi-AI маршрутизации для API Cockpit.
//
// Источник истины не дублируется: профиль читается из того же
// profiles/<profile>/runners.env, а task override и фактический результат —
// из t<task>.pipeline. Порядок приоритетов повторяет engine/lib/routing.sh.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { parsePipeline } from './pipeline-parse.js';

const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const STAGE_ID = /^[A-Z][A-Z0-9_]*$/;

function uniqueProviders(values) {
  const out = [];
  for (const value of values) {
    const id = String(value || '').trim();
    if (PROVIDER_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function splitChain(value) {
  return uniqueProviders(String(value || '').split(','));
}

function policy(primaryValue, failoverValue, source) {
  const chain = uniqueProviders([...splitChain(primaryValue), ...splitChain(failoverValue)]);
  return {
    primary: chain[0] || null,
    failover: chain.slice(1),
    chain,
    source,
  };
}

function modelPolicy(profileConfig, stage, provider) {
  const providerKey = String(provider || '').toUpperCase().replace(/-/g, '_');
  if (!providerKey || !STAGE_ID.test(stage)) return null;
  const value = (suffix) => profileConfig[`MODEL_${stage}_${providerKey}_${suffix}`]
    || profileConfig[`MODEL_DEFAULT_${providerKey}_${suffix}`]
    || null;
  const exact = value('EXACT');
  const family = value('FAMILY');
  if (!exact && !family) return null;
  return {
    exact,
    family,
    version: value('VERSION') || (family ? 'latest' : null),
    variant: value('VARIANT') || (family ? 'auto' : null),
    effort: value('EFFORT'),
  };
}

/** Синхронно читает небольшой canonical runners.env; отсутствующий/невалидный → {}. */
export function loadRunnerConfig(profilesDir, profile) {
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
export function resolveProjectRunnerState(profileConfig) {
  return policy(
    profileConfig.PROJECT_RUNNER_PRIMARY,
    profileConfig.PROJECT_RUNNER_FAILOVER,
    'profile-project',
  );
}

/** Полная цепочка и runtime-телеметрия этапа. */
export function resolveRunnerState(profileConfig, registry, stage) {
  const key = STAGE_ID.test(String(stage || '')) ? stage : '';
  let resolved;

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
    ? registry[`RUNNER_ACTUAL_${key}`]
    : null;
  const models = Object.fromEntries(resolved.chain.map((provider) => [
    provider,
    modelPolicy(profileConfig, key, provider),
  ]));
  return {
    ...resolved,
    actual,
    family: key ? registry[`MODEL_FAMILY_${key}`] || null : null,
    model: key ? registry[`MODEL_ACTUAL_${key}`] || null : null,
    reason: key ? registry[`RUNNER_REASON_${key}`] || null : null,
    planLevel: key ? registry[`PLAN_LEVEL_${key}`] || null : null,
    catalogRevision: key ? registry[`CATALOG_REVISION_${key}`] || null : null,
    switched: !!(actual && resolved.primary && actual !== resolved.primary),
    models,
  };
}

/**
 * История реально стартовавших процессов этапа. meta.env пишет runner-launcher;
 * это диагностические данные, поэтому битый/исчезнувший run не ломает весь граф.
 */
export async function readRunnerAttempts(stateDir, task, stage) {
  if (!/^\d+$/.test(String(task || '')) || !STAGE_ID.test(String(stage || ''))) return [];
  const root = path.join(stateDir, 'logs', 'runs', `t${task}`, stage);
  let ids;
  try {
    ids = await fsp.readdir(root);
  } catch {
    return [];
  }
  const attempts = [];
  await Promise.all(ids.map(async (id) => {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    try {
      const meta = parsePipeline(await fsp.readFile(path.join(root, id, 'meta.env'), 'utf8'));
      attempts.push({
        id,
        epoch: /^\d+$/.test(meta.EPOCH || '') ? Number(meta.EPOCH) : null,
        runner: PROVIDER_ID.test(meta.RUNNER || '') ? meta.RUNNER : null,
        model: meta.MODEL || null,
        result: meta.RESULT_CLASS || null,
        rc: /^-?\d+$/.test(meta.RC || '') ? Number(meta.RC) : null,
        source: meta.SOURCE || null,
      });
    } catch { /* незавершённый запуск ещё мог не записать meta.env */ }
  }));
  attempts.sort((a, b) => (a.epoch ?? Number.MAX_SAFE_INTEGER) - (b.epoch ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id));
  return attempts.slice(-20);
}
