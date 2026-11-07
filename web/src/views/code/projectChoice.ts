// Какой проект панель «Кода» открывает без участия человека.
//
// Правило одно: догадка панели не должна открывать архивный проект — им больше не
// работают, и заставать человека в нём при каждом заходе незачем. Явный выбор
// (последний проект или ссылка) сильнее догадки: архив ничего не прячет силой,
// и открытый по имени архивный проект показывается как обычно.

interface CodeProjectLike {
  id: string;
  repos?: Array<unknown> | null;
  archivedAt?: string | null;
}

/**
 * Проект для автооткрытия: сначала названный человеком, затем активный с путями,
 * затем любой активный и только потом — хоть что-нибудь из списка.
 * @returns выбранный проект либо null, если список пуст
 */
export function pickCodeProject<Project extends CodeProjectLike>(
  projects: Project[],
  wanted: string,
): Project | null {
  const list = Array.isArray(projects) ? projects : [];
  const named = wanted ? list.find((item) => item.id === wanted) : undefined;

  if (named) {
    return named;
  }

  const active = list.filter((item) => !item.archivedAt);
  const withRepos = active.filter((item) => (item.repos || []).length);

  return withRepos[0] || active[0] || list[0] || null;
}
