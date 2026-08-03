// Versioned-ссылка на модель чата. Пара provider/model устраняет коллизии одинаковых
// model id у разных исполнителей и запрещает исторический fallback «не нашли → Claude».

export const CHAT_SCHEMA = 2;
export const CHAT_SURFACES = new Set(['chats', 'embedded']);
export const LEGACY_DUAL_WRITE_PROVIDERS = new Set(['claude', 'codex']);

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || '';
}

export function normalizeModelRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = nonEmpty(value.provider);
  const model = nonEmpty(value.model);
  if (!provider || !model) return null;
  return { provider, model };
}

function exactModel(models, modelId) {
  return (models || []).find((model) => model?.id === modelId) || null;
}

function legacyModels(models, modelId) {
  const exact = (models || []).filter((model) => (
    model?.id === modelId || (model?.aliases || []).includes(modelId)
  ));
  if (exact.length) return exact;
  // Семейства — только legacy-совместимость. В modelRef всегда сохраняется фактический
  // runtime id, поэтому неоднозначное семейство внутри provider-а выбирается тем же
  // правилом, что и прежний реестр: свежая non-extra модель с максимальным tier.
  const family = (models || []).filter((model) => model?.family === modelId);
  if (!family.length) return [];
  return [family.sort((left, right) => (
    Number(!!left.extra) - Number(!!right.extra)
      || Number(right.tier || 0) - Number(left.tier || 0)
  ))[0]];
}

function failed(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/**
 * Разрешает уже versioned пару. Provider является частью ключа: поиск в соседних
 * providers и любой fallback запрещены.
 */
export function resolveModelRef(value, registry) {
  const ref = normalizeModelRef(value);
  if (!ref) return failed('invalid_model_ref');
  if (!Object.hasOwn(registry || {}, ref.provider)) {
    return failed('unknown_provider', { modelRef: ref });
  }
  const model = exactModel(registry[ref.provider], ref.model);
  if (!model) return failed('unknown_model', { modelRef: ref });
  return { ok: true, modelRef: { provider: ref.provider, model: model.id }, model };
}

/**
 * Legacy `model` не содержит provider. Разрешаем его только при единственном результате;
 * коллизия — отдельное состояние, а не выбор первого provider по порядку реестра.
 */
export function resolveLegacyModel(modelId, registry) {
  const wanted = nonEmpty(modelId);
  if (!wanted) return failed('missing_model');
  const matches = [];
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
  const [{ provider, model }] = matches;
  return { ok: true, modelRef: { provider, model: model.id }, model };
}

export function modelRefState(result) {
  if (result?.ok) return { state: 'resolved' };
  return {
    state: result?.error || 'missing_model',
    ...(result?.legacyModel ? { legacyModel: result.legacyModel } : {}),
    ...(result?.candidates ? { candidates: result.candidates } : {}),
  };
}

/**
 * Запись истории → schema 2. `surface` назначает вызывающий server store; присланное
 * клиентом значение сюда намеренно не передаётся.
 */
export function migrateChatModelRecord(chat, registry, { surface = 'chats' } = {}) {
  const source = chat && typeof chat === 'object' ? chat : {};
  const explicit = normalizeModelRef(source.modelRef);
  const resolved = explicit
    ? resolveModelRef(explicit, registry)
    : resolveLegacyModel(source.model, registry);
  const next = {
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

export function migrateDefaultModel(meta, registry) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const explicit = normalizeModelRef(source.defModelRef);
  const resolved = explicit
    ? resolveModelRef(explicit, registry)
    : resolveLegacyModel(source.defModel, registry);
  const next = { ...source, defModelRefState: modelRefState(resolved) };
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

export function sameModelRef(left, right) {
  const a = normalizeModelRef(left);
  const b = normalizeModelRef(right);
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}
