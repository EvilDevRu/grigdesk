import { api } from './apiClient.ts';
import {
  parseCodeCommitResponse,
  parseCodeCommitTitleResponse,
  parseCodeDirectory,
  parseCodeFile,
  parseCodeGit,
  parseCodeProjects,
  parseCodePushResponse,
  parseCodeRepos,
  parseCodeRoots,
  parseCodeStageResponse,
} from '../../../shared/codeContracts.ts';
import type { CodeRequestContext } from '../../../shared/codeContracts.ts';

export interface CodeStageOptions {
  all?: boolean;
  paths?: string[];
}

function contextUrl(context: CodeRequestContext, action: string): string {
  const query = new URLSearchParams({
    repo: context.repoKey,
    root: context.treePath,
  });

  return `/api/code/${encodeURIComponent(context.project)}/${action}?${query}`;
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

  async commit(context: CodeRequestContext, message: string) {
    const value: unknown = await api.post(contextUrl(context, 'commit'), { message });

    return parseCodeCommitResponse(value);
  },

  async push(context: CodeRequestContext) {
    const value: unknown = await api.post(contextUrl(context, 'push'), {});

    return parseCodePushResponse(value);
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
