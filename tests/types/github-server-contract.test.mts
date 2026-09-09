import { normalizeOpenedIssue } from '../../server/src/lib/github/normalize.ts';
import { githubRulesPolicyFingerprint } from '../../server/src/lib/github/rulesStore.ts';
import { validateGitHubWebhookHeaders } from '../../server/src/lib/github/webhook.ts';
import type { GitHubConnectionStatus } from '../../server/src/lib/github/connection.ts';
import type { GitHubModuleOptions } from '../../server/src/modules/github/index.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type MessageIsChecked = Checked<IsUnchecked<ReturnType<typeof normalizeOpenedIssue>>>;
export type EnvelopeIsChecked = Checked<IsUnchecked<
  ReturnType<typeof validateGitHubWebhookHeaders>
>>;
export type StatusIsChecked = Checked<IsUnchecked<GitHubConnectionStatus>>;

/**
 * Границу канала держат три вещи: проверенный конверт доставки, нормализованное
 * сообщение и отпечаток политики. Ни одна из них не должна принимать чужую форму
 * от соседнего JavaScript — иначе issue чужого репозитория попадёт в общий Inbox.
 */
async function checkServerContracts(connection: GitHubModuleOptions['connection']): Promise<void> {
  // @ts-expect-error Нормализовать нечего без самого payload доставки.
  normalizeOpenedIssue();
  // @ts-expect-error Отпечаток политики считается по всей тройке владельцев.
  githubRulesPolicyFingerprint('acc_1');
  // @ts-expect-error Приём webhook называет ingress, тело и заголовки.
  await connection?.handleWebhook('ingress-1');

  const envelope = validateGitHubWebhookHeaders({}, {
    expectedHookId: '1',
    expectedRepositoryId: '2',
  });

  // @ts-expect-error Идентификатор доставки — строка, а не число.
  envelope.deliveryId.toFixed();

  const message = normalizeOpenedIssue({}, { accountRef: 'acc_1', expectedRepositoryId: '2' });

  // @ts-expect-error У обращения GitHub нет вложений: список объявлен пустым.
  message.attachments.push({ file: 'a.png' });
}

void checkServerContracts;
