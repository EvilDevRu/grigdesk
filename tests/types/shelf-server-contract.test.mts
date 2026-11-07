import { TaskShelfStore, normalizeShelfTaskId } from '../../server/src/lib/taskShelfStore.ts';
import type { ShelfSnapshot } from '../../server/src/lib/taskShelfStore.ts';
import { TaskShelfService } from '../../server/src/lib/taskShelfService.ts';
import type { TaskShelfModuleOptions } from '../../server/src/modules/task-shelf/index.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type SnapshotIsChecked = Checked<IsUnchecked<ShelfSnapshot>>;
export type EntryIsChecked = Checked<IsUnchecked<ShelfSnapshot['entries'][number]>>;
export type ServiceListIsChecked = Checked<IsUnchecked<
  Awaited<ReturnType<TaskShelfModuleOptions['shelf']['list']>>
>>;

/**
 * Полка сервера отвечает подтверждённым снимком целиком, а область берёт из портальной
 * сессии. Соседний JavaScript не должен превращать ни то, ни другое в свободный вызов.
 */
async function checkServerContracts(store: TaskShelfStore, shelf: TaskShelfService): Promise<void> {
  // @ts-expect-error Хранилище знает только путь к своему файлу.
  new TaskShelfStore('/tmp/shelf.json');
  // @ts-expect-error Запись всегда называет и область, и задачу, и тело.
  store.put('scope-a');
  // @ts-expect-error Область полки задаёт сервер, а не вызывающая сторона.
  shelf.list('scope-a');
  // @ts-expect-error Канонический номер задачи является строкой.
  const id: number = normalizeShelfTaskId('42');

  const snapshot = await store.list('scope-a');

  // @ts-expect-error Полка области может быть пустой.
  snapshot.entries[0].title.toLowerCase();

  void id;
}

void checkServerContracts;
