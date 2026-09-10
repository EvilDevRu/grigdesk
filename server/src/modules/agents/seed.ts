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
import { listFactoryProfiles } from '../../lib/profiles.ts';
import { defaults } from './store.ts';
import type { AgentRecord, AgentsStore } from './store.ts';
import type { AgentCard } from '../../../../shared/agentsContracts.ts';

// Схема профиля фабрики. Читаются только статические поля: узел — кортеж
// [kind, label, sub], keys — рекомендуемые ключи реестра, optional — штатные пропуски.
interface ProfileGraph {
  nodes?: Record<string, string[]>;
  keys?: Record<string, string>;
  optional?: Record<string, string[]>;
}

// Строка плана посева: что было на диске, что станет и какие поля разошлись.
interface SeedPlanEntry {
  id: string;
  before: AgentCard | null;
  beforeFingerprint: string | null;
  next: AgentRecord;
  fields: string[];
  action: 'create' | 'update' | 'unchanged';
}

// Что показывается человеку: три списка по роду изменения.
interface SeedDiff {
  create: Array<{ id: string; fields: string[] }>;
  update: Array<{ id: string; fields: string[] }>;
  unchanged: string[];
}

// Ответ preview. `applySupported: false` — честный отказ legacy-применения.
export interface SeedPreview {
  n: number;
  written: number;
  applied: boolean;
  applySupported: boolean;
  previewToken: string;
  diff: SeedDiff;
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/** Читает graph.json профиля: sub-сноски, ключи реестра, optional-этапы. */
async function readGraph(profilesDir: string, profile: string): Promise<ProfileGraph> {
  const p = path.join(profilesDir, profile, 'graph.json');
  return JSON.parse(await fs.readFile(p, 'utf8')) as ProfileGraph;
}

/** Статические id и рекомендуемые registry keys из graph.json. */
function stagesOf(g: ProfileGraph): Array<{ id: string; k1: string }> {
  return Object.keys(g.nodes || {}).map((id) => ({
    id,
    k1: g.keys?.[id] || id.toUpperCase(),
  }));
}

function changedFields(previous: AgentRecord | null, next: AgentRecord): string[] {
  const fields = Object.keys(defaults()) as Array<keyof AgentRecord>;

  if (!previous) return fields;

  return fields.filter((field) => previous[field] !== next[field]);
}

function publicDiff(plan: SeedPlanEntry[]): SeedDiff {
  return {
    create: plan.filter(({ action }) => action === 'create')
      .map(({ id, fields }) => ({ id, fields })),
    update: plan.filter(({ action }) => action === 'update')
      .map(({ id, fields }) => ({ id, fields })),
    unchanged: plan.filter(({ action }) => action === 'unchanged')
      .map(({ id }) => id),
  };
}

function previewToken(plan: SeedPlanEntry[]): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

// Отказ reseed несёт preview: без него человеку нечего сравнивать в ответе 409.
function seedError(code: string, message: string, preview: SeedPreview): Error {
  const error = new Error(message) as Error & { code: string; preview: SeedPreview };

  error.code = code;
  error.preview = preview;

  return error;
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
 */
export async function seedAgents(
  store: AgentsStore,
  config: { profilesDir: string },
  _log: unknown,
  { apply = false, expectedToken = '' } = {},
): Promise<SeedPreview> {
  const claimed = new Set<string>();
  const plan: SeedPlanEntry[] = [];
  for (const profile of (await listFactoryProfiles(config.profilesDir)).sort()) {
    const g = await readGraph(config.profilesDir, profile);
    const stages = stagesOf(g);
    if (!stages.length) continue;
    const optional = new Set(Object.values(g.optional || {}).flat());

    for (const { id, k1 } of stages) {
      if (claimed.has(id)) continue; // шаблон уже есть — специфика профиля живёт в его схемах
      claimed.add(id);
      const node = g.nodes?.[id] || [];
      let prev: AgentCard | null = null;
      try {
        prev = await store.get(id);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      let beforeFingerprint: string | null = null;
      try {
        const bytes = await store.readBytes(id);
        beforeFingerprint = createHash('sha256').update(bytes).digest('hex');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
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
    throw seedError('stale_preview', 'reseed preview is stale', preview);
  }
  if (apply) {
    throw seedError('reseed_apply_unsupported', 'legacy reseed apply is disabled', preview);
  }
  return preview;
}
