// Архивность проекта — один факт, который читают сразу несколько разделов.
//
// Живёт он отдельным модулем без зависимостей намеренно: его спрашивают и библиотека
// проектов, и список профилей, и потребители (запуск конвейера, песочницы, правила).
// Положить его в любой из них значило бы завести цикл импортов или вторую трактовку
// «в архиве» — а трактовка тут ровно одна: непустая строка `archivedAt` в паспорте.

/** Реестр паспортов: содержимое недоверенное, поэтому форма проверяется здесь. */
export interface ArchivePrefsReader {
  read?: () => unknown;
}

function storedProjects(prefs: ArchivePrefsReader | null | undefined): Record<string, unknown> {
  try {
    const stored = prefs?.read?.() as { projects?: unknown } | null | undefined;
    const projects = stored?.projects;

    return projects !== null && typeof projects === 'object' && !Array.isArray(projects)
      ? projects as Record<string, unknown>
      : {};
  } catch {
    // Нечитаемый файл настроек не делает проекты архивными: «не знаю» здесь означает
    // «показывай как обычно», а отказ записи разбирает раздел «Проекты».
    return {};
  }
}

/** Идентификаторы проектов в архиве: их не предлагают там, где начинают новое. */
export function archivedProjectIds(prefs: ArchivePrefsReader | null | undefined): Set<string> {
  const archived = new Set<string>();

  for (const [id, record] of Object.entries(storedProjects(prefs))) {
    const at = (record as { archivedAt?: unknown } | null)?.archivedAt;

    if (typeof at === 'string' && at) {
      archived.add(id);
    }
  }

  return archived;
}

export function isProjectArchived(
  prefs: ArchivePrefsReader | null | undefined,
  id: string,
): boolean {
  return archivedProjectIds(prefs).has(id);
}
