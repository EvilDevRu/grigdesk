import type { ShelfEntry, ShelfState } from '../../shared/b24/shelfContracts.ts';
import { parseShelfState } from '../../shared/b24/shelfContracts.ts';
import { shelfApi } from '../../web/src/shared/shelfApi.ts';
import taskShelfDecision from '../../web/src/shared/taskShelfDecision.ts';
import type { ShelfRow } from '../../web/src/stores/taskShelf.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type EntryIsChecked = Checked<IsUnchecked<ShelfEntry>>;
export type RowIsChecked = Checked<IsUnchecked<ShelfRow>>;
export type ApiListIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof shelfApi.list>>>>;

/**
 * Примеры запускает только компилятор. Полка меняется необратимыми PUT и DELETE, и
 * непроверенный снимок не имеет права доехать до состояния раздела молча.
 */
function checkContracts(input: unknown, row: ShelfRow): void {
  // @ts-expect-error Непроверенный JSON не является снимком полки.
  const unchecked: ShelfState = input;
  // @ts-expect-error Ревизия снимка хранится числом, а не строкой интерфейса.
  const revision: ShelfState['revision'] = '1';
  // @ts-expect-error Причина постановки ограничена объявленным перечислением.
  shelfApi.put('42', { title: 'Задача', reason: 'ждём', snapshot: {}, createIfMissing: true });
  // @ts-expect-error Снятие с полки называет задачу.
  shelfApi.remove();
  // @ts-expect-error Строка карточки несёт наблюдаемый снимок, а не серверную запись.
  const durable: ShelfEntry = row;

  const state = parseShelfState(input);

  // @ts-expect-error Полка может быть пустой.
  state.entries[0].title.toLowerCase();

  const decision = taskShelfDecision({ observed: input });

  // @ts-expect-error Наблюдение источника может отсутствовать целиком.
  decision.snapshot.analysis.state;

  void [unchecked, revision, durable];
}

void checkContracts;
