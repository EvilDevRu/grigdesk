import { validateInboxMessage } from '../../server/src/lib/inbox/message.ts';
import { bundleInboxMessages } from '../../server/src/lib/inbox/bundle.ts';
import { decodeInboxRef } from '../../server/src/lib/inbox/identity.ts';
import { projectDecisionState } from '../../server/src/lib/inbox/stateStore.ts';
import type { InboxStateStore } from '../../server/src/lib/inbox/stateStore.ts';
import type { InboxModuleOptions } from '../../server/src/modules/inbox/index.ts';
import {
  decideInboxAutoAction,
  parseInboxTriagePlan,
  parseInboxTriageVerdict,
} from '../../server/src/lib/inbox/triage.ts';
import { selectAttachableFiles } from '../../server/src/lib/inbox/taskService.ts';
import type { InboxAttachmentAnalysisResult } from '../../server/src/lib/inbox/attachmentAnalysis.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type MessageIsChecked = Checked<IsUnchecked<ReturnType<typeof validateInboxMessage>>>;
export type BundleIsChecked = Checked<IsUnchecked<ReturnType<typeof bundleInboxMessages>>>;
export type RefIsChecked = Checked<IsUnchecked<ReturnType<typeof decodeInboxRef>>>;
export type CoordinatorIsChecked = Checked<IsUnchecked<InboxModuleOptions['coordinator']>>;
export type VerdictIsChecked = Checked<IsUnchecked<ReturnType<typeof parseInboxTriageVerdict>>>;
export type AnalysisIsChecked = Checked<IsUnchecked<InboxAttachmentAnalysisResult>>;

/**
 * Границу общего Inbox держат три вещи: нормализованное сообщение канала, ссылка на
 * него и решение по нему. Ни одна не должна принимать чужую форму от соседнего
 * JavaScript — иначе сообщение другого аккаунта попадёт в чужую карточку, а решение
 * ляжет поверх уже принятого.
 */
async function checkServerContracts(store: InboxStateStore, input: unknown): Promise<void> {
  const owner = { expectedChannel: 'telegram', expectedAccountRef: 'account' };

  // @ts-expect-error Провайдерский id сообщения — строка, числом он не бывает.
  validateInboxMessage(input, owner).id.toFixed();
  // @ts-expect-error Связок может не собраться ни одной.
  bundleInboxMessages(input, { channel: 'telegram', accountRef: 'account' })[0].messages.length;
  // @ts-expect-error У ссылки на карточку полей сообщения нет.
  decodeInboxRef(input, { kind: 'item' }).messageId.trim();

  const decision = await store.decide({
    activationEpoch: 1,
    originItemRef: 'item',
    messageRefs: ['message'],
    scopeRef: 'scope',
    status: 'task',
    taskId: '1',
  });

  // @ts-expect-error Автор решения закрыт перечислением.
  const by: typeof decision.by = 'робот';
  // @ts-expect-error Возврат отдаёт остаток решения или ничего.
  (await store.reset({ decisionId: decision.decisionId, expectedVersion: 1 })).version.toFixed();

  const projection = projectDecisionState(['message'], [decision]);

  // @ts-expect-error У смешанной карточки одного решения нет.
  projection.decision.decisionId.trim();

  void by;
}

/**
 * Разбор моделью и подготовка вложений отвечают недоверенным ответом: у него может
 * не быть ни вердикта, ни плана, а решение об автозадаче принимается не по нему
 * одному. Компилятор обязан удерживать оба «может не быть» на месте.
 */
function checkTriageContracts(reply: unknown, analysis: InboxAttachmentAnalysisResult): void {
  // @ts-expect-error Модель могла не ответить по контракту — вердикта нет.
  parseInboxTriageVerdict(reply).kind.toUpperCase();
  // @ts-expect-error Разбиение считается по числу показанных модели сообщений.
  parseInboxTriagePlan(reply).statements.length.toFixed();
  // @ts-expect-error Решение по карточке называет род работы строкой, а не числом.
  const action: number = decideInboxAutoAction({ item: {}, verdict: null }).action;
  // @ts-expect-error Список вложений может оказаться пустым.
  analysis.entries[0].status.trim();
  // @ts-expect-error Кому уезжает вложение, решает сторона решения, а не булев флаг.
  selectAttachableFiles([], {}, { by: true });

  void action;
}

void checkServerContracts;
void checkTriageContracts;
