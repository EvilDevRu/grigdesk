// Семейство — стабильная policy-настройка («sol»), а конкретный id каталога
// («gpt-5.6-sol») меняется с rollout. Эти helpers не знают исполнителей заранее:
// новый provider просто отдаёт поле family в своей записи каталога.

export function modelFamilyOf(model) {
  return String(model?.family || '').trim();
}

function isBetterFamilyCandidate(next, current) {
  if (!current) return true;
  if (!!next.extra !== !!current.extra) return !next.extra;
  return Number(next.tier || 0) > Number(current.tier || 0);
}

/** По одной актуальной модели на семейство; hidden/устаревшие — только fallback. */
export function familyModels(models = []) {
  const byFamily = new Map();
  for (const source of models) {
    const family = modelFamilyOf(source);
    if (!family) continue;
    const model = { ...source, family };
    if (isBetterFamilyCandidate(model, byFamily.get(family))) byFamily.set(family, model);
  }
  return [...byFamily.values()].sort((a, b) => Number(b.tier || 0) - Number(a.tier || 0));
}

/**
 * Старое точное id, CLI-алиас и новое имя семейства приводим к текущей модели.
 * matched сохраняет исходную запись: UI может оставить точный id явным pin'ом.
 */
export function resolveModelFamily(providers = [], value = '') {
  const wanted = String(value || '').trim();
  if (!wanted) return null;

  for (const provider of providers) {
    const matched = (provider.models || []).find((model) =>
      model.id === wanted || (model.aliases || []).includes(wanted));
    if (!matched) continue;
    const family = modelFamilyOf(matched);
    if (!family) return { provider, model: matched, matched, family: '' };
    const model = familyModels(provider.models || []).find((candidate) => candidate.family === family)
      || { ...matched, family };
    return { provider, model, matched, family };
  }

  for (const provider of providers) {
    const model = familyModels(provider.models || []).find((candidate) => candidate.family === wanted);
    if (model) return { provider, model, matched: model, family: model.family };
  }
  return null;
}

export function familyLabel(family) {
  return String(family || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
