import type { InboxChannel, InboxItem, InboxSummary } from '../../shared/inbox/inboxContracts.ts';
import { parseInboxList, parseInboxSummary } from '../../shared/inbox/inboxContracts.ts';
import { inboxApi } from '../../web/src/shared/inboxApi.ts';
import { refreshInboxSummary, useInboxStore } from '../../web/src/actions/inbox';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type ItemIsChecked = Checked<IsUnchecked<InboxItem>>;
export type SummaryIsChecked = Checked<IsUnchecked<InboxSummary>>;
export type ApiListIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof inboxApi.list>>>>;

/**
 * Примеры запускает только компилятор. Состояние карточки и участие канала — рубежи
 * решений: по первому видно, разобрано ли обращение, по второму — принимает ли канал
 * новые. Непроверенный JSON не имеет права стать ни тем, ни другим.
 */
function checkContracts(input: unknown, store: ReturnType<typeof useInboxStore>): void {
  // @ts-expect-error Непроверенный JSON не является карточкой входящих.
  const unchecked: InboxItem = input;
  // @ts-expect-error Состояние карточки закрыто перечислением.
  const status: InboxItem['status'] = 'разобрано';
  // @ts-expect-error Участие канала закрыто перечислением.
  const participation: InboxChannel['participation'] = 'inactive';
  // @ts-expect-error Решение называет и карточку, и действие, и тело блокировки.
  inboxApi.decide('item-a');
  // @ts-expect-error Стор состояния сам в сеть не ходит.
  store.load();
  // @ts-expect-error Обновление сводки аргументов не принимает.
  refreshInboxSummary('telegram');

  const list = parseInboxList(input);
  const summary = parseInboxSummary(input);

  // @ts-expect-error Список карточек может быть пустым.
  list.items[0].ref.trim();
  // @ts-expect-error Разбор автомата приходит не всегда.
  summary.channels.length.toFixed();

  void [unchecked, status, participation];
}

void checkContracts;
