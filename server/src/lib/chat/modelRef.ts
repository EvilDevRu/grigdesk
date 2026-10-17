// Versioned-ссылка на модель чата. Пара provider/model устраняет коллизии одинаковых
// model id у разных исполнителей и запрещает исторический fallback «не нашли → Claude».

import { trimmedText } from '../../../../shared/lib/text.ts';

export const CHAT_SCHEMA = 2;
export const CHAT_SURFACES = new Set(['chats', 'embedded']);
export const LEGACY_DUAL_WRITE_PROVIDERS = new Set(['claude', 'codex']);

// Versioned-ссылка на модель: пара provider/model.
export interface ModelRef {
  provider: string;
  model: string;
}

// Модель в реестре исполнителя. Alias-поля читаются только совместимостью.
export interface RegistryModel {
  id?: string;
  family?: string;
  tier?: number;
  extra?: boolean;
  aliases?: string[];
  modelRefAliases?: string[];
}

// Реестр целиком: провайдер → его модели.
export type ModelRegistry = Record<string, RegistryModel[] | undefined>;

// Итог разрешения ссылки. Форма разная по исходу: модель есть ровно при ok.
export type ModelResolution =
  | { ok: true; modelRef: ModelRef; model: RegistryModel }
  | {
    ok: false;
    error: string;
    modelRef?: ModelRef;
    legacyModel?: string;
    candidates?: Array<{ provider: string; model?: string }>;
  };

export function normalizeModelRef(value: unknown): ModelRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as { provider?: unknown; model?: unknown };
  const provider = trimmedText(source.provider);
  const model = trimmedText(source.model);
  if (!provider || !model) return null;
  return { provider, model };
}

function exactModel(
  models: RegistryModel[] | undefined,
  modelId: string,
): RegistryModel | null {
  const list = models || [];
  // Реальный id сильнее declarative alias даже при испорченном/custom models.json.
  return list.find((model) => model?.id === modelId)
    || list.find((model) => (model?.modelRefAliases || []).includes(modelId))
    || null;
}

function legacyModels(models: RegistryModel[] | undefined, modelId: string): RegistryModel[] {
  const exact = (models || []).filter((model) => (
    model?.id === modelId
      || (model?.modelRefAliases || []).includes(modelId)
      || (model?.aliases || []).includes(modelId)
  ));
  if (exact.length) return exact;
  // Семейства — только legacy-совместимость. В modelRef всегда сохраняется фактический
  // runtime id, поэтому неоднозначное семейство внутри provider-а выбирается тем же
  // правилом, что и прежний реестр: свежая non-extra модель с максимальным tier.
  const family = (models || []).filter((model) => model?.family === modelId);
  const best = family.sort((left, right) => (
    Number(!!left.extra) - Number(!!right.extra)
      || Number(right.tier || 0) - Number(left.tier || 0)
  ))[0];
  return best ? [best] : [];
}

function failed(error: string, extra: Record<string, unknown> = {}): ModelResolution {
  return { ok: false, error, ...extra };
}

/**
 * Разрешает уже versioned пару. Provider является частью ключа: поиск в соседних
 * providers и любой fallback запрещены. Разрешены только retired-equivalent exact id
 * из `modelRefAliases`; динамические CLI-алиасы (`opus`) остаются legacy-механизмом.
 */
export function resolveModelRef(value: unknown, registry: ModelRegistry): ModelResolution {
  const ref = normalizeModelRef(value);
  if (!ref) return failed('invalid_model_ref');
  if (!Object.hasOwn(registry || {}, ref.provider)) {
    return failed('unknown_provider', { modelRef: ref });
  }
  const model = exactModel(registry[ref.provider], ref.model);
  if (!model) return failed('unknown_model', { modelRef: ref });
  return { ok: true, modelRef: { provider: ref.provider, model: String(model.id) }, model };
}

/**
 * Legacy `model` не содержит provider. Разрешаем его только при единственном результате;
 * коллизия — отдельное состояние, а не выбор первого provider по порядку реестра.
 */
export function resolveLegacyModel(modelId: unknown, registry: ModelRegistry): ModelResolution {
  const wanted = trimmedText(modelId);
  if (!wanted) return failed('missing_model');
  const matches: Array<{ provider: string; model: RegistryModel }> = [];
  for (const [provider, models] of Object.entries(registry || {})) {
    for (const model of legacyModels(models, wanted)) {
      matches.push({ provider, model });
    }
  }
  if (!matches.length) return failed('unknown_model', { legacyModel: wanted });
  if (matches.length > 1) {
    return failed('ambiguous_model', {
      legacyModel: wanted,
      candidates: matches.map(({ provider, model }) => ({ provider, model: model.id })),
    });
  }
  const first = matches[0];
  if (!first) return failed('unknown_model', { legacyModel: wanted });
  return {
    ok: true,
    modelRef: { provider: first.provider, model: String(first.model.id) },
    model: first.model,
  };
}

// Состояние ссылки для записи истории: `resolved` либо код отказа с подробностями.
export interface ModelRefState {
  state: string;
  legacyModel?: string;
  candidates?: Array<{ provider: string; model?: string }>;
}

export function modelRefState(result: ModelResolution | null | undefined): ModelRefState {
  if (result?.ok) return { state: 'resolved' };
  const failure = result?.ok === false ? result : null;

  return {
    state: failure?.error || 'missing_model',
    ...(failure?.legacyModel ? { legacyModel: failure.legacyModel } : {}),
    ...(failure?.candidates ? { candidates: failure.candidates } : {}),
  };
}

/**
 * Запись истории → schema 2. `surface` назначает вызывающий server store; присланное
 * клиентом значение сюда намеренно не передаётся.
 */
export function migrateChatModelRecord(
  chat: unknown,
  registry: ModelRegistry,
  { surface = 'chats' } = {},
): { chat: Record<string, unknown>; resolution: ModelResolution } {
  const source = (chat && typeof chat === 'object' ? chat : {}) as Record<string, unknown>;
  const explicit = normalizeModelRef(source.modelRef);
  const resolved = explicit
    ? resolveModelRef(explicit, registry)
    : resolveLegacyModel(source.model, registry);
  const next: Record<string, unknown> = {
    ...source,
    schema: CHAT_SCHEMA,
    surface: CHAT_SURFACES.has(surface) ? surface : 'embedded',
    modelRefState: modelRefState(resolved),
  };
  if (resolved.ok) {
    next.modelRef = resolved.modelRef;
    // Rollback window: предыдущая версия Cockpit умеет читать только legacy model.
    if (LEGACY_DUAL_WRITE_PROVIDERS.has(resolved.modelRef.provider)) {
      next.model = resolved.modelRef.model;
    } else {
      delete next.model;
    }
  } else if (explicit) {
    // Неизвестную versioned пару сохраняем для диагностики/ручного перевыбора, но
    // resolver всё равно не даст по ней запустить процесс.
    next.modelRef = explicit;
  } else {
    delete next.modelRef;
  }
  return { chat: next, resolution: resolved };
}

export function migrateDefaultModel(
  meta: unknown,
  registry: ModelRegistry,
): { meta: Record<string, unknown>; resolution: ModelResolution } {
  const source = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
  const explicit = normalizeModelRef(source.defModelRef);
  const resolved = explicit
    ? resolveModelRef(explicit, registry)
    : resolveLegacyModel(source.defModel, registry);
  const next: Record<string, unknown> = { ...source, defModelRefState: modelRefState(resolved) };
  if (resolved.ok) {
    next.defModelRef = resolved.modelRef;
    if (LEGACY_DUAL_WRITE_PROVIDERS.has(resolved.modelRef.provider)) {
      next.defModel = resolved.modelRef.model;
    }
  } else if (explicit) {
    next.defModelRef = explicit;
  } else {
    delete next.defModelRef;
  }
  return { meta: next, resolution: resolved };
}

export function sameModelRef(left: unknown, right: unknown): boolean {
  const a = normalizeModelRef(left);
  const b = normalizeModelRef(right);
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}
