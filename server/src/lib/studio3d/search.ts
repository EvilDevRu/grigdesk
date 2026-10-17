// Поиск работает по сводке и тексту версий, а финансовые суммы разделены по
// исполнителю/единице. Оценка никогда не заменяет подтверждённое списание.
import path from 'node:path';

import { ACTIVE_STATUSES, MODEL_CATEGORIES } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dExpenditure, Studio3dModel } from '../../../../shared/studio3d/studio3dContracts.ts';
import { operationSpec } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { DiskModel, DiskVersion, ModelEntry } from './library.ts';

export interface SearchQuery {
  q?: string;
  project?: string;
  category?: string;
  has?: string;
  origin?: string;
  provider?: string;
  from?: string;
  to?: string;
  sort?: 'updated' | 'created' | 'name' | 'spent';
  offset?: number;
  limit?: number;
}

export type FileUrl = (modelId: string, versionId: string, name: string) => string;

/**
 * Одинаковая нормализация применяется к запросу и стогу модели. Ё/е и номер
 * задачи с # не требуют от человека точного написания stored подписи.
 */
export function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/#/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Группы расходов не складывают кредиты и жетоны. Refunded учитывает только
 * известную величину, actual:null сохраняет неизвестность отдельно от estimate.
 */
export function spendingFor(lines: readonly Pick<DiskVersion, 'provider' | 'cost'>[]): Studio3dExpenditure[] {
  const groups = new Map<string, Studio3dExpenditure>();

  for (const line of lines) {
    if (line.cost.free) {
      continue;
    }

    const unit = line.cost.unit;
    const provider = line.provider ?? 'unknown';
    const key = JSON.stringify([provider, unit?.one, unit?.few, unit?.many]);
    const group = groups.get(key) ?? {
      provider,
      unit,
      actual: 0,
      estimated: 0,
      refunded: 0,
      unknownCount: 0,
      unknownEstimated: 0
    };

    group.estimated += line.cost.estimated ?? 0;

    if (line.cost.state === 'refunded') {
      group.refunded += line.cost.actual ?? 0;
    } else if (line.cost.actual !== null && ['charged', 'unknown'].includes(line.cost.state)) {
      group.actual += line.cost.actual;
    }

    if (line.cost.state === 'unknown' || (line.cost.actual === null
      && ['charged', 'refunded'].includes(line.cost.state))) {
      group.unknownCount += 1;
      group.unknownEstimated += line.cost.estimated ?? 0;
    }

    groups.set(key, group);
  }

  return [...groups.values()];
}

/**
 * Preview берётся из main, затем из последней ready версии с preview.
 * Поля размера являются логическими manifest байтами, active включает unknown.
 */
export function summarizeModel(model: DiskModel, versions: DiskVersion[], fileUrl: FileUrl): Studio3dModel {
  const main = versions.find((version) => version.id === model.mainVersion);
  const previewVersion = main?.files.some((file) => file.role === 'preview') ? main
    : versions.filter((version) => version.status === 'ready'
      && version.files.some((file) => file.role === 'preview')).at(-1);
  const preview = previewVersion?.files.find((file) => file.role === 'preview');
  const spending = spendingFor(versions);
  const materialGroups = spending.filter((group) => group.actual > 0 || group.estimated > 0);

  return {
    id: model.id,
    name: model.name,
    project: model.project,
    category: model.category,
    tags: model.tags,
    origin: model.origin,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    mainVersion: model.mainVersion,
    preview: preview && previewVersion ? fileUrl(model.id, previewVersion.id, preview.name) : null,
    versions: versions.length,
    active: versions.filter((version) => ACTIVE_STATUSES.includes(version.status)).length,
    spent: materialGroups.length > 1 ? null : materialGroups[0]?.actual ?? 0,
    spending,
    sizeBytes: versions.reduce((total, version) => total
      + version.files.reduce((bytes, file) => bytes + file.size, 0), 0),
    has: {
      rig: versions.some((version) => ['rigged', 'animated'].includes(version.kind)
        || (version.stats?.bones ?? 0) > 0),
      animation: versions.some((version) => version.kind === 'animated'
        || (version.stats?.animations.length ?? 0) > 0),
      parts: versions.some((version) => version.kind === 'parts' || (version.stats?.parts.length ?? 0) > 1),
      images: versions.some((version) => ['image', 'views'].includes(version.kind)
        || version.files.some((file) => ['image', 'front', 'left', 'back', 'right'].includes(file.role))),
    },
  };
}

/**
 * Стог включает как пользовательские заметки, так и operation/task/file подписи.
 * Значения форм остаются текстом; nested вход не превращается в HTML.
 */
function haystack(entry: ModelEntry): string {
  const category = MODEL_CATEGORIES.find((item) => item.id === entry.model.category)?.label ?? '';
  const pieces = [
    entry.model.name, entry.model.notes, entry.model.project ?? '', category, ...entry.model.tags,
  ];

  for (const version of entry.versions) {
    pieces.push(version.label, operationSpec(version.operation ?? '')?.label ?? '', version.task?.id ?? '');

    for (const key of ['prompt', 'negative_prompt', 'hint']) {
      const value = version.params[key];

      if (typeof value === 'string') {
        pieces.push(value);
      }
    }

    pieces.push(
      ...version.files.map((file) => file.name),
      ...version.savedTo.map((file) => path.basename(file.path)),
    );
  }

  return normalizeSearch(pieces.join(' '));
}

/**
 * Фильтры пересекаются, каждое слово и каждый has должны совпасть.
 * Сортировка стабильна по id, total вычисляется до bounded пагинации.
 */
export function searchModels(entries: ModelEntry[], query: SearchQuery, fileUrl: FileUrl) {
  const words = normalizeSearch(query.q ?? '').split(' ').filter(Boolean);
  const required = (query.has ?? '').split(',').filter(Boolean);
  const from = query.from ? Date.parse(query.from) : null;
  const to = query.to ? Date.parse(query.to) : null;
  const filtered = entries.filter((entry) => {
    const model = entry.model;
    const summary = summarizeModel(model, entry.versions, fileUrl);
    const text = haystack(entry);
    const updated = Date.parse(model.updatedAt);

    return (!query.project || model.project === query.project)
      && (!query.category || model.category === query.category)
      && (!query.origin || model.origin === query.origin)
      && (!query.provider || entry.versions.some((version) => version.provider === query.provider))
      && (from === null || updated >= from) && (to === null || updated <= to)
      && words.every((word) => text.includes(word))
      && required.every((flag) => Object.hasOwn(summary.has, flag)
        && summary.has[flag as keyof typeof summary.has]);
  }).map((entry) => summarizeModel(entry.model, entry.versions, fileUrl));

  filtered.sort((a, b) => {
    const compare = query.sort === 'name' ? a.name.localeCompare(b.name, 'ru')
      : query.sort === 'spent' ? (b.spent ?? -1) - (a.spent ?? -1)
        : Date.parse(query.sort === 'created' ? b.createdAt : b.updatedAt)
          - Date.parse(query.sort === 'created' ? a.createdAt : a.updatedAt);

    return compare || a.id.localeCompare(b.id);
  });

  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));

  return { models: filtered.slice(offset, offset + limit), total: filtered.length };
}
