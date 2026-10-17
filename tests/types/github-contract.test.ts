import type { GitHubRule, GitHubRuleInput, GitHubStatus } from '../../shared/inbox/githubContracts.ts';
import { parseGitHubPolicy, parseGitHubStatus } from '../../shared/inbox/githubContracts.ts';
import { githubApi } from '../../web/src/shared/githubApi.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type StatusIsChecked = Checked<IsUnchecked<GitHubStatus>>;
export type RuleIsChecked = Checked<IsUnchecked<GitHubRule>>;
export type ApiStatusIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof githubApi.status>>>>;

/**
 * Примеры запускает только компилятор. Подключение репозитория как канала Inbox и
 * доступ агентов к его содержимому — два разных решения человека, и ни одно из них
 * не должно опираться на непроверенный JSON или на угаданное состояние.
 */
function checkContracts(input: unknown): void {
  // @ts-expect-error Непроверенный JSON не является статусом подключения.
  const unchecked: GitHubStatus = input;
  // @ts-expect-error Состояние привязки закрыто перечислением.
  const state: GitHubStatus['state'] = 'наверное';
  // @ts-expect-error Род обращения закрыт перечислением.
  const kind: GitHubRuleInput['kind'] = 'question';
  // @ts-expect-error Ступень приоритета закрыта перечислением.
  const priority: NonNullable<GitHubRule['b24']>['priority'] = 7;
  // @ts-expect-error Правило allowlist не меняет доступ агентам: у него своя ручка.
  githubApi.saveRules('1', [{ repositoryId: '1', project: 'a', kind: 'bug', agentSearch: true }]);
  // @ts-expect-error Изменение доступа требует отпечатка политики.
  githubApi.setAgentSearch('1', true);

  const policy = parseGitHubPolicy(input);

  // @ts-expect-error Отпечатка может не быть: правил ещё нет.
  policy.policyFingerprint.startsWith('ghpol1:');
  // @ts-expect-error Список правил может быть пустым.
  policy.rules[0].project.trim();

  const status = parseGitHubStatus(input);

  // @ts-expect-error Репозиторий может быть не подключён вовсе.
  status.repositoryId.padStart(2, '0');

  void [unchecked, state, kind, priority];
}

void checkContracts;
