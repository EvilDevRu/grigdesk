// Семейство — стабильная policy-настройка («sol»), а конкретный id каталога
// («gpt-5.6-sol») меняется с rollout. Эти helpers не знают исполнителей заранее:
// новый provider просто отдаёт поле family в своей записи каталога. Одно правило
// выбора актуальной модели служит и разрешению ссылок, и краткому списку в выборе.

// Запись каталога моделей. Форму объявляет сам provider, поэтому здесь перечислено
// ровно то, по чему выбирается актуальная модель семейства.
export interface CatalogModel extends Record<string, unknown> {
  id?: string;
  family?: string;
  tier?: unknown;
  extra?: unknown;
  variantOf?: unknown;
  aliases?: string[];
  modelRefAliases?: string[];
}

// Исполнитель со своим каталогом.
export interface CatalogProvider extends Record<string, unknown> {
  models?: CatalogModel[];
}

// Разрешённая ссылка на модель: чем закрыли запрос и что человек указал изначально.
export interface ResolvedFamily {
  provider: CatalogProvider;
  model: CatalogModel;
  matched: CatalogModel;
  family: string;
}

/**
 * Семейство записи каталога. Пустая строка означает «провайдер его не объявил» —
 * такая модель существует, но представлять семейство в списке ей нечем.
 */
export function modelFamilyOf(model: CatalogModel | null | undefined): string {
  return String(model?.family || '').trim();
}

/**
 * Кто из двух записей одного семейства должен представлять его в списке. Основная
 * модель сильнее дополнительной, а при равенстве побеждает старший tier: выбор не
 * должен зависеть от порядка, в котором провайдер перечислил каталог.
 */
function isBetterFamilyCandidate(
  next: CatalogModel,
  current: CatalogModel | undefined,
): boolean {
  if (!current) {
    return true;
  }

  if (!!next.extra !== !!current.extra) {
    return !next.extra;
  }

  return Number(next.tier || 0) > Number(current.tier || 0);
}

/**
 * По одной актуальной модели на семейство; hidden и устаревшие остаются только
 * фоллбэком. Записи без объявленного семейства пропускаются — им нечего представлять.
 */
export function familyModels(models: CatalogModel[] = []): CatalogModel[] {
  const byFamily = new Map<string, CatalogModel>();

  for (const source of models) {
    const family = modelFamilyOf(source);

    if (!family) {
      continue;
    }

    const model = { ...source, family };

    if (isBetterFamilyCandidate(model, byFamily.get(family))) {
      byFamily.set(family, model);
    }
  }

  return [...byFamily.values()].sort((a, b) => Number(b.tier || 0) - Number(a.tier || 0));
}

/**
 * Старое точное id, CLI-алиас и новое имя семейства приводим к текущей модели.
 * matched сохраняет исходную запись: UI может оставить точный id явным pin'ом.
 */
export function resolveModelFamily(
  providers: CatalogProvider[] = [],
  value: unknown = '',
): ResolvedFamily | null {
  const wanted = String(value || '').trim();

  if (!wanted) {
    return null;
  }

  for (const provider of providers) {
    const matched = (provider.models || []).find((model) => (
      model.id === wanted
      || (model.modelRefAliases || []).includes(wanted)
      || (model.aliases || []).includes(wanted)
    ));

    if (!matched) {
      continue;
    }

    const family = modelFamilyOf(matched);

    if (!family) {
      return {
        provider,
        model: matched,
        matched,
        family: '',
      };
    }

    const model = familyModels(provider.models || [])
      .find((candidate) => candidate.family === family)
      || { ...matched, family };

    return {
      provider,
      model,
      matched,
      family,
    };
  }

  for (const provider of providers) {
    const model = familyModels(provider.models || [])
      .find((candidate) => candidate.family === wanted);

    if (model) {
      return {
        provider,
        model,
        matched: model,
        family: String(model.family),
      };
    }
  }

  return null;
}

/**
 * Краткий список: в каждом семействе актуальна одна модель, прежние версии получают
 * `extra` и уходят под настройку «Показывать все модели». Правило только добавляет флаг:
 * скрытое исполнителем не всплывает, записи без семейства и формы актуальной модели
 * (`variantOf`, например другое окно контекста) остаются. Вход не меняется.
 */
export function markSupersededModels<T extends CatalogModel>(models: T[]): T[] {
  const current = new Map<string, CatalogModel>();

  for (const model of models) {
    const family = modelFamilyOf(model);

    if (family && isBetterFamilyCandidate(model, current.get(family))) {
      current.set(family, model);
    }
  }

  return models.map((model) => {
    const latest = current.get(modelFamilyOf(model));

    if (!latest || latest === model || model.extra || model.variantOf === latest.id) {
      return model;
    }

    return { ...model, extra: true };
  });
}

/**
 * Человеческая подпись семейства: «gpt_5-sol» → «Gpt 5 Sol». Своего словаря названий
 * здесь нет намеренно — имена придумывает провайдер, и новое семейство не ждёт правки кода.
 */
export function familyLabel(family: unknown): string {
  return String(family || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
