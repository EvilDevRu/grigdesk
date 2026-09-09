import { api } from './api-client.js';
import {
  parseGitHubAgentSearch,
  parseGitHubPolicy,
  parseGitHubRulesSaved,
  parseGitHubStatus,
} from '../../../shared/githubContracts.ts';
import type { GitHubRuleInput } from '../../../shared/githubContracts.ts';

/**
 * Единственная граница сети раздела GitHub. Ответ сервера здесь и проверяется, и
 * обрезается до объявленных полей: у привязки на диске рядом лежат токен, секрет
 * webhook и ingressRef, и случайно расширенная проекция не должна доехать до шаблона.
 */
export const githubApi = {
  async status() {
    const value: unknown = await api.get('/api/github/status');

    return parseGitHubStatus(value);
  },

  /**
   * Три управляющие ручки отвечают тем же статусом, но раздел его не читает: после
   * любой из них он перечитывает состояние отдельным запросом. Проверять ответ, на
   * который никто не смотрит, значило бы завести отказ там, где решения нет.
   */
  async connect(owner: string, repo: string, token: string): Promise<void> {
    await api.post('/api/github/connect', {
      owner,
      repo,
      token,
    });
  },

  async recheck(): Promise<void> {
    await api.post('/api/github/recheck', {});
  },

  async disconnect(): Promise<void> {
    await api.post('/api/github/disconnect', {});
  },

  async rules() {
    const value: unknown = await api.get('/api/github/rules');

    return parseGitHubPolicy(value);
  },

  /**
   * Сохранение allowlist. `repositoryId` едет отдельным полем как optimistic CAS:
   * сервер берёт namespace из своей привязки, а не из тела, и старая вкладка не
   * очистит правила уже подключённого другого репозитория.
   */
  async saveRules(repositoryId: string, rules: GitHubRuleInput[]) {
    const value: unknown = await api.put('/api/github/rules', { repositoryId, rules });

    return parseGitHubRulesSaved(value);
  },

  /**
   * Доступ агентов к содержимому issues. Отпечаток политики обязателен: без него
   * повторная попытка ушла бы вслепую и могла перекрыть чужое решение.
   */
  async setAgentSearch(
    repositoryId: string,
    expectedPolicyFingerprint: string,
    enabled: boolean,
  ) {
    const value: unknown = await api.put('/api/github/rules/agent-search', {
      repositoryId,
      expectedPolicyFingerprint,
      enabled,
    });

    return parseGitHubAgentSearch(value);
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Выключенный плагин отвечает своим кодом под 404. Раздел различает его с поломкой:
 * это штатное состояние, и показывать вместо него красную ошибку нельзя.
 */
export function githubPluginDisabled(error: unknown): boolean {
  const failure = asRecord(error);

  return failure.status === 404 && asRecord(failure.data).error === 'plugin_disabled';
}

/**
 * Текст отказа для человека. Сервер GitHub присылает готовое сообщение вместе с
 * машинным кодом, а обрыв сети приходит без тела — тогда остаётся текст операции.
 */
export function githubErrorMessage(error: unknown, fallback: string): string {
  const message = asRecord(error).message;

  return typeof message === 'string' && message ? message : fallback;
}
