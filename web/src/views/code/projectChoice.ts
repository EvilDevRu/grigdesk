interface CodeProjectLike {
  id: string;
  repos?: Array<unknown> | null;
}

/**
 * Автооткрытие использует рабочий каталог сервера: сначала сохранённый выбор,
 * затем первый проект с путями и затем любой активный проект.
 */
export function pickCodeProject<Project extends CodeProjectLike>(
  projects: Project[],
  wanted: string,
): Project | null {
  const named = projects.find((item) => item.id === wanted);
  const withRepos = projects.find((item) => item.repos?.length);

  return named || withRepos || projects[0] || null;
}
