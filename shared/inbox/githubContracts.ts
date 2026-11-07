// Контракт раздела GitHub. Здесь два разных вопроса, и оба решает человек по ответу
// сервера: подключён ли репозиторий как канал общего Inbox и что именно из него в этот
// Inbox допущено. Оба перечисления закрыты намеренно — «незнакомое состояние» на экране
// молча выбрало бы запасную ветку, а ветки тут разные: одна показывает форму входа,
// другая обещает, что очередь работает.
//
// Отпечаток политики — это CAS для галочки поиска агентам. Он проверяется по форме
// здесь же: подставной или пустой отпечаток отправил бы повторное изменение доступа
// вслепую, поверх чужой правки.

import { contractDecoders } from '../lib/contractDecoders.ts';

export class GitHubContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ GitHub: поле ${path}`);
    this.name = 'GitHubContractError';
  }
}

const {
  boolean,
  listOf,
  nullable,
  numeric,
  objectOf,
  oneOf,
  optional,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new GitHubContractError(path);
});

const POLICY_FINGERPRINT_RE = /^ghpol1:[0-9a-f]{64}$/u;

/**
 * Отпечаток политики: строка строгой формы или её отсутствие. Отсутствие — законное
 * состояние (правил ещё нет), а вот строка чужого вида означает, что CAS доверять
 * нельзя, и раздел должен узнать об этом сразу, а не при попытке записи.
 */
function policyFingerprint(value: unknown, path: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const fingerprint = text(value, path);

  if (!POLICY_FINGERPRINT_RE.test(fingerprint)) {
    throw new GitHubContractError(path);
  }

  return fingerprint;
}

// Состояние привязки на диске: `pending` ждёт подписанного ping от webhook, а
// `cleanup_pending` означает, что локальный ingress закрыт, но remote hook ещё жив.
const bindingState = oneOf('pending', 'connected', 'cleanup_pending');

// Состояние живого канала. Оно шире состояния привязки: `degraded` относится к
// текущему процессу и после перезапуска сервера может смениться само.
const connectionState = oneOf(
  'disconnected',
  'connecting',
  'connected',
  'disconnecting',
  'degraded',
);

const githubStatus = objectOf({
  configured: boolean,
  state: nullable(bindingState),
  repositoryId: nullable(text),
  fullName: nullable(text),
  connectedAt: nullable(numeric),
  connection: connectionState,
  reason: nullable(text),
  cleanupPending: boolean,
});

// Поля задачи Битрикс24 у правила. Пустое значение — это null, а не ноль: ноль был бы
// настоящим идентификатором, и подставлять его вместо «не задано» нельзя.
const ruleTracker = objectOf({
  responsibleId: nullable(wholeNumber),
  groupId: nullable(wholeNumber),
  priority: oneOf(0, 1, 2),
});

const ruleAutoTask = objectOf({
  enabled: boolean,
  minConfidence: numeric,
  maxPerDay: wholeNumber,
});

/**
 * Правило allowlist. `agentSearch` человек не редактирует вместе с остальным: у него
 * своя CAS-ручка, и в старых записях на диске поля может не быть вовсе.
 */
const githubRule = objectOf({
  repositoryId: text,
  project: text,
  kind: oneOf('bug', 'wish'),
  b24: optional(ruleTracker),
  autoTask: optional(ruleAutoTask),
  agentSearch: optional(boolean),
});

const githubPolicy = objectOf({
  rules: listOf(githubRule),
  policyFingerprint,
});

const rulesSaved = objectOf({
  ok: boolean,
  rules: listOf(githubRule),
});

const agentSearchSaved = objectOf({
  ok: boolean,
  rules: listOf(githubRule),
  policyFingerprint,
});

export type GitHubStatus = ReturnType<typeof githubStatus>;
export type GitHubRule = ReturnType<typeof githubRule>;
export type GitHubPolicy = ReturnType<typeof githubPolicy>;
export type GitHubRuleTracker = ReturnType<typeof ruleTracker>;
export type GitHubRuleAutoTask = ReturnType<typeof ruleAutoTask>;

// Что уезжает на сервер при сохранении правила. `agentSearch` здесь отсутствует
// намеренно: сервер отклоняет его в этой ручке, и тип обязан говорить то же самое.
export interface GitHubRuleInput {
  repositoryId: string;
  project: string;
  kind: 'bug' | 'wish';
  b24?: GitHubRuleTracker;
  autoTask?: GitHubRuleAutoTask;
}

export function parseGitHubStatus(value: unknown): GitHubStatus {
  return githubStatus(value, 'githubStatus');
}

export function parseGitHubPolicy(value: unknown): GitHubPolicy {
  return githubPolicy(value, 'githubPolicy');
}

export function parseGitHubRulesSaved(value: unknown): GitHubRule[] {
  return rulesSaved(value, 'githubRulesSaved').rules;
}

/**
 * Ответ на изменение доступа агентам. Отпечаток здесь возвращается новый: следующая
 * правка должна идти уже от него, иначе повторный CAS уедет со старым.
 */
export function parseGitHubAgentSearch(value: unknown): GitHubPolicy {
  const saved = agentSearchSaved(value, 'githubAgentSearch');

  return { rules: saved.rules, policyFingerprint: saved.policyFingerprint };
}
