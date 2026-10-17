import { api } from './apiClient.ts';
import {
  parseCodeBlame,
  parseCodeCommitResponse,
  parseCodeCommitTitleResponse,
  parseCodeDirectory,
  parseCodeFile,
  parseCodeFileDiff,
  parseCodeFileLog,
  parseCodeFetchResponse,
  parseCodeGit,
  parseCodeCommitsDiff,
  parseCodePatch,
  parseCodeProjects,
  parseCodePushResponse,
  parseCodeRepos,
  parseCodeRoots,
  parseCodeSearch,
  parseCodeStageResponse,
  parseCodeUndoCommitResponse,
} from '../../../shared/plugins/code/codeContracts.ts';
import type { CodeRequestContext } from '../../../shared/plugins/code/codeContracts.ts';

export interface CodeStageOptions {
  all?: boolean;
  paths?: string[];
}

export interface CodeFileDiffOptions {
  group: 'staged' | 'work' | 'commits';
  path: string;
  base?: string;
  to?: string;
  work?: boolean;
}

// Режим «с текущими изменениями» отрезка коммитов: правая сторона — рабочее дерево.
export interface CodeRangeOptions {
  work?: boolean;
}

export interface CodeCommitOptions {
  amend?: boolean;
}

export interface CodePatchOptions {
  group: 'staged' | 'work' | 'commits';
  base?: string;
  to?: string;
  path?: string;
  work?: boolean;
}

function contextUrl(context: CodeRequestContext, action: string): string {
  const query = new URLSearchParams({
    repo: context.repoKey,
    root: context.treePath,
  });

  return `/api/code/${encodeURIComponent(context.project)}/${action}?${query}`;
}

/**
 * Добавляет параметры к уже закодированному URL контекста одной границей.
 * Все значения проходят URLSearchParams и не конкатенируются вручную.
 */
function actionUrl(
  context: CodeRequestContext,
  action: string,
  values: Record<string, string | undefined>,
) {
  const url = new URL(contextUrl(context, action), 'http://cockpit.local');

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  return `${url.pathname}?${url.searchParams}`;
}

/**
 * Единственная граница JSON для панели и файловых ссылок. Общий клиент знает
 * HTTP, а конкретный декодер подтверждает форму до обновления состояния «Кода».
 */
export const codeApi = {
  async projects() {
    const value: unknown = await api.get('/api/projects');

    return parseCodeProjects(value).projects;
  },

  async roots() {
    const value: unknown = await api.get('/api/code/roots');

    return parseCodeRoots(value).roots;
  },

  async repos(project: string) {
    const value: unknown = await api.get(`/api/code/${encodeURIComponent(project)}/repos`);

    return parseCodeRepos(value).repos;
  },

  async list(context: CodeRequestContext, relative = '') {
    const suffix = relative ? `&dir=${encodeURIComponent(relative)}` : '';
    const value: unknown = await api.get(contextUrl(context, 'ls') + suffix);

    return parseCodeDirectory(value).entries;
  },

  async file(context: CodeRequestContext, path: string) {
    const value: unknown = await api.get(`${contextUrl(context, 'file')}&path=${encodeURIComponent(path)}`);

    return parseCodeFile(value);
  },

  async git(context: CodeRequestContext) {
    const value: unknown = await api.get(contextUrl(context, 'git'));

    return parseCodeGit(value);
  },

  async fileDiff(context: CodeRequestContext, options: CodeFileDiffOptions) {
    const value: unknown = await api.get(actionUrl(context, 'file-diff', {
      group: options.group,
      path: options.path,
      base: options.base,
      to: options.to,
      work: options.work ? '1' : undefined,
    }));

    return parseCodeFileDiff(value);
  },

  async fileLog(context: CodeRequestContext, path: string) {
    const value: unknown = await api.get(actionUrl(context, 'file-log', { path }));

    return parseCodeFileLog(value);
  },

  async blame(context: CodeRequestContext, path: string) {
    const value: unknown = await api.get(actionUrl(context, 'blame', { path }));

    return parseCodeBlame(value);
  },

  async search(context: CodeRequestContext, query: string) {
    const value: unknown = await api.get(actionUrl(context, 'search', { q: query }));

    return parseCodeSearch(value);
  },

  async commitsDiff(
    context: CodeRequestContext,
    from: string,
    to: string,
    options: CodeRangeOptions = {},
  ) {
    const value: unknown = await api.get(actionUrl(context, 'commits-diff', {
      from,
      to,
      work: options.work ? '1' : undefined,
    }));

    return parseCodeCommitsDiff(value);
  },

  async branchDiff(context: CodeRequestContext, options: CodeRangeOptions = {}) {
    const value: unknown = await api.get(actionUrl(context, 'branch-diff', {
      work: options.work ? '1' : undefined,
    }));

    return parseCodeCommitsDiff(value);
  },

  async patch(context: CodeRequestContext, options: CodePatchOptions) {
    const value: unknown = await api.get(actionUrl(context, 'patch', {
      group: options.group,
      base: options.base,
      to: options.to,
      path: options.path,
      work: options.work ? '1' : undefined,
    }));

    return parseCodePatch(value);
  },

  rawUrl(context: CodeRequestContext, path: string): string {
    return api.url(`${contextUrl(context, 'raw')}&path=${encodeURIComponent(path)}`);
  },

  async stage(context: CodeRequestContext, options: CodeStageOptions) {
    const value: unknown = await api.post(contextUrl(context, 'stage'), options);

    return parseCodeStageResponse(value);
  },

  async unstage(context: CodeRequestContext, options: CodeStageOptions) {
    const value: unknown = await api.post(contextUrl(context, 'unstage'), options);

    return parseCodeStageResponse(value);
  },

  async discard(context: CodeRequestContext, options: CodeStageOptions) {
    const value: unknown = await api.post(contextUrl(context, 'discard'), options);

    return parseCodeStageResponse(value);
  },

  async clean(context: CodeRequestContext, options: Pick<CodeStageOptions, 'paths'>) {
    const value: unknown = await api.post(contextUrl(context, 'clean'), options);

    return parseCodeStageResponse(value);
  },

  async commit(context: CodeRequestContext, message: string, options: CodeCommitOptions = {}) {
    const value: unknown = await api.post(contextUrl(context, 'commit'), {
      message,
      ...(options.amend ? { amend: true } : {}),
    });

    return parseCodeCommitResponse(value);
  },

  async push(context: CodeRequestContext) {
    const value: unknown = await api.post(contextUrl(context, 'push'), {});

    return parseCodePushResponse(value);
  },

  async fetch(context: CodeRequestContext) {
    const value: unknown = await api.post(contextUrl(context, 'fetch'), {});

    return parseCodeFetchResponse(value);
  },

  async undoCommit(context: CodeRequestContext) {
    const value: unknown = await api.post(contextUrl(context, 'undo-commit'), {});

    return parseCodeUndoCommitResponse(value);
  },

  async commitMessage(context: CodeRequestContext) {
    const value: unknown = await api.post(contextUrl(context, 'commit-message'), {});

    return parseCodeCommitTitleResponse(value);
  },
};

/**
 * Сообщение HTTP имеет приоритет над транспортной ошибкой. Нестандартное исключение
 * не получает доступ к полям без проверки и заменяется понятным запасным текстом.
 */
export function codeErrorMessage(error: unknown, fallback = 'Не удалось выполнить действие'): string {
  if (typeof error !== 'object' || error === null) {
    return fallback;
  }

  if ('data' in error && typeof error.data === 'object' && error.data !== null) {
    if ('message' in error.data && typeof error.data.message === 'string' && error.data.message) {
      return error.data.message;
    }
  }

  return 'message' in error && typeof error.message === 'string' && error.message ? error.message : fallback;
}
