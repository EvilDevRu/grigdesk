export type ChatWorkdir =
  | { kind: 'cockpit'; }
  | {
    kind: 'project';
    projectId: string;
    repoKey: string | null;
  }
  | { kind: 'path'; path: string; };

export interface WorkdirCapability {
  switch: 'resume' | 'reseed';
  roots: 'multi' | 'single';
}

/**
 * Общая проверка формы не обращается к файловой системе.
 * Только отсутствие поля означает старый чат; явный мусор не превращается в cockpit.
 */
export function normalizeChatWorkdir(value: unknown): ChatWorkdir | null {
  if (value === undefined) {
    return { kind: 'cockpit' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);

  if (source.kind === 'cockpit' && keys.length === 1) {
    return { kind: 'cockpit' };
  }
  if (source.kind === 'path' && keys.every((key) => ['kind', 'path'].includes(key))) {
    const input = typeof source.path === 'string' ? source.path.trim() : '';

    return input.startsWith('/') && input.length <= 4096 && !/[\x00-\x1f]/u.test(input)
      ? { kind: 'path', path: input }
      : null;
  }
  if (source.kind === 'project' && keys.every((key) => ['kind', 'projectId', 'repoKey'].includes(key))) {
    const projectId = typeof source.projectId === 'string' ? source.projectId : '';
    const repoKey = source.repoKey;

    if (/^[a-z0-9][a-z0-9_-]{0,40}$/u.test(projectId)
      && (repoKey === null || (typeof repoKey === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(repoKey)))) {
      return {
        kind: 'project',
        projectId,
        repoKey
      };
    }
  }

  return null;
}

/**
 * Сравниваем нормализованный выбор без зависимости от порядка полей входного JSON.
 * Отсутствующее поле старого чата эквивалентно явному выбору Кокпита.
 */
export function sameChatWorkdir(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeChatWorkdir(left)) === JSON.stringify(normalizeChatWorkdir(right));
}

/**
 * Короткая подпись выбора пригодна окну и истории.
 * Фактический путь проекта показывает только ответ серверного предпросмотра.
 */
export function chatWorkdirLabel(value: unknown): string {
  const workdir = normalizeChatWorkdir(value);

  if (workdir?.kind === 'path') {
    return workdir.path;
  }
  if (workdir?.kind === 'project') {
    return workdir.repoKey ? `${workdir.projectId} · ${workdir.repoKey}` : workdir.projectId;
  }

  return workdir ? 'Кокпит' : 'Папка не определена';
}

/**
 * Недавние папки ограничены восемью нормализованными выборами.
 * Повреждённые записи метаданных не попадают в предлагаемый человеку список.
 */
export function normalizeRecentWorkdirs(value: unknown): ChatWorkdir[] {
  const result: ChatWorkdir[] = [];

  for (const item of Array.isArray(value) ? value : []) {
    const workdir = normalizeChatWorkdir(item);

    if (workdir && !result.some((saved) => sameChatWorkdir(saved, workdir))) {
      result.push(workdir);
    }
    if (result.length === 8) {
      break;
    }
  }

  return result;
}
