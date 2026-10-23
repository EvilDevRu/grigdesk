interface DeletionPrefs {
  read?: () => unknown;
  readForWrite?: () => unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Разбирает только служебные надгробия, не обращаясь к профилям на диске.
 * Строгий режим запрещает новый выбор при повреждении реестра.
 */
function idsOf(value: unknown, strict: boolean): Set<string> {
  const ids = new Set<string>();
  const meta = object(value) ? value.projectsMeta : undefined;

  if (meta === undefined) {
    return ids;
  }

  if (!object(meta) || (meta.tombstones !== undefined && !object(meta.tombstones))) {
    if (strict) {
      throw new Error('Повреждены служебные записи проектов.');
    }

    return ids;
  }

  for (const [id, row] of Object.entries(meta.tombstones ?? {})) {
    if (object(row) && typeof row.deletedAt === 'string' && row.deletedAt
      && Number.isSafeInteger(row.revision) && Number(row.revision) > 0) {
      ids.add(id);
    } else if (strict) {
      throw new Error('Повреждена запись удалённого проекта.');
    }
  }

  return ids;
}

/**
 * Обзор переживает нечитаемые настройки так же, как прежний каталог.
 * Новые ссылки используют отдельную строгую проверку ниже.
 */
export function deletedProjectIds(prefs: DeletionPrefs | null | undefined): Set<string> {
  try {
    return idsOf(prefs?.read?.(), false);
  } catch {
    return new Set();
  }
}

/**
 * Перед записью читается свежий файл, поэтому ошибка чтения не разрешает ссылку.
 * Модуль намеренно не зависит от discovery и паспортов проектов.
 */
export function isProjectDeleted(prefs: DeletionPrefs | null | undefined, id: string): boolean {
  return idsOf(prefs?.readForWrite?.() ?? prefs?.read?.(), true).has(id);
}
