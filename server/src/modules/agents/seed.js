// Посев библиотеки ШАБЛОНОВ агентов из всех профилей фабрики.
// Модель данных: агент — переиспользуемый шаблон роли (метаданные + заготовка
// промпта); боевой промпт каждого этапа принадлежит СХЕМЕ и лежит сайдкаром
// routes/<профиль>/<маршрут>/<этап>.md (см. модуль routes).
//
// Безопасный reseed-preview метаданных читает только profiles/<профиль>/graph.json
// и планирует изменения курируемых полей. Ни preview, ни disabled apply не source-ят
// profile.sh. Shell-extractor удалён: динамические prompt-ветки мигрируются вручную.
//
// Коллизии id между профилями суффиксами НЕ разводятся: один id = один шаблон,
// первый профиль (по алфавиту) даёт заготовку промпта, остальные — только свои
// сайдкары в маршрутах. Никакой карты переименований больше нет.
//
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listFactoryProfiles } from '../../lib/profiles.js';
import { defaults } from './store.js';

/** Читает graph.json профиля: sub-сноски, ключи реестра, optional-этапы. */
async function readGraph(profilesDir, profile) {
  const p = path.join(profilesDir, profile, 'graph.json');
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/** Статические id и рекомендуемые registry keys из graph.json. */
function stagesOf(g) {
  return Object.keys(g.nodes || {}).map((id) => ({
    id,
    k1: g.keys?.[id] || id.toUpperCase(),
  }));
}

function changedFields(previous, next) {
  if (!previous) return Object.keys(defaults());
  return Object.keys(defaults()).filter((field) => previous[field] !== next[field]);
}

function publicDiff(plan) {
  return {
    create: plan.filter(({ action }) => action === 'create')
      .map(({ id, fields }) => ({ id, fields })),
    update: plan.filter(({ action }) => action === 'update')
      .map(({ id, fields }) => ({ id, fields })),
    unchanged: plan.filter(({ action }) => action === 'unchanged')
      .map(({ id }) => id),
  };
}

function previewToken(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/**
 * Строит статический preview посева библиотеки шаблонов. Legacy-хранилище не
 * позволяет атомарно опубликовать весь набор файлов, поэтому apply намеренно
 * отключён до перехода на immutable revisions.
 *
 * Один id — один шаблон: повторное появление id в другом профиле шаблон не
 * перетирает. Digest включает точный hash исходного файла и весь статический план.
 *
 * В reseed намеренно входят только статические graph-поля. Исполняемый profile.sh
 * не source-ится ни в preview, ни в apply: tier/timeout/budget/readonly и ручные
 * prompt/effort сохраняются как есть.
 *
 * @returns {{n: number, written: number, applied: boolean, previewToken: string, diff: object}}
 */
export async function seedAgents(store, config, _log, {
  apply = false,
  expectedToken = '',
} = {}) {
  const claimed = new Set();
  const plan = [];
  for (const profile of (await listFactoryProfiles(config.profilesDir)).sort()) {
    const g = await readGraph(config.profilesDir, profile);
    const stages = stagesOf(g);
    if (!stages.length) continue;
    const optional = new Set(Object.values(g.optional || {}).flat());

    for (const { id, k1 } of stages) {
      if (claimed.has(id)) continue; // шаблон уже есть — специфика профиля живёт в его схемах
      claimed.add(id);
      const node = g.nodes?.[id] || [];
      let prev = null;
      try {
        prev = await store.get(id);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      let beforeFingerprint = null;
      try {
        const bytes = await store.readBytes(id);
        beforeFingerprint = createHash('sha256').update(bytes).digest('hex');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const kept = prev || defaults();
      const next = {
        kind: node[0] || 'agent',
        label: (node[1] || id).replace(/^(🤖|👤|<\/>)\s*/, ''),
        sub: node[2] || '',
        key: k1,
        tier: kept.tier,
        effort: kept.effort,
        timeout: kept.timeout,
        budget: kept.budget,
        readonly: kept.readonly,
        optional: optional.has(id),
        prompt: kept.prompt,
      };
      const fields = changedFields(prev, next);
      plan.push({
        id,
        before: prev,
        beforeFingerprint,
        next,
        fields,
        action: !prev ? 'create' : fields.length ? 'update' : 'unchanged',
      });
    }
  }

  plan.sort((a, b) => a.id.localeCompare(b.id));
  const token = previewToken(plan);
  const preview = {
    n: plan.length,
    written: 0,
    applied: false,
    applySupported: false,
    previewToken: token,
    diff: publicDiff(plan),
  };
  if (apply && expectedToken !== token) {
    const error = new Error('reseed preview is stale');
    error.code = 'stale_preview';
    error.preview = preview;
    throw error;
  }
  if (apply) {
    const error = new Error('legacy reseed apply is disabled');
    error.code = 'reseed_apply_unsupported';
    error.preview = preview;
    throw error;
  }
  return preview;
}
