import type {
  KnowledgeImportConflict,
  KnowledgeListResponse,
  KnowledgeRecord,
} from '../../shared/knowledgeContracts.ts';
import { parseKnowledgeList } from '../../shared/knowledgeContracts.ts';
import { knowledgeApi } from '../../web/src/shared/knowledgeApi.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type RecordIsChecked = Checked<IsUnchecked<KnowledgeRecord>>;
export type ApiListIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof knowledgeApi.list>>>>;
export type FoundIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof knowledgeApi.search>>[number]>>;

/**
 * Примеры запускает только компилятор. Если непроверенный JSON или неверное решение
 * человека начнут приниматься молча, обязательный typecheck раздела упадёт.
 */
function checkContracts(input: unknown, file: File, conflict: KnowledgeImportConflict): void {
  // @ts-expect-error Непроверенный JSON не является списком знаний.
  const unchecked: KnowledgeListResponse = input;
  // @ts-expect-error Ревизия хранится числом, а не строкой интерфейса.
  const revision: KnowledgeRecord['revision'] = '3';
  // @ts-expect-error Запись из файла резервной копии не несёт происхождения.
  conflict.incoming.provenance;
  // @ts-expect-error Решение конфликта ограничено двумя объявленными вариантами.
  knowledgeApi.applyImport(file, 'hash', [{ id: '1', decision: 'skip', expectedCurrentRevision: 1 }]);
  // @ts-expect-error Правка записи требует ожидаемую ревизию.
  knowledgeApi.update('id', {
    project: 'demo', repository: 'main', kind: 'fact', title: 'Заголовок', body: '', tags: ['topic'],
  });
  // @ts-expect-error Удаление сверяет ревизию числом, а не строкой поля.
  knowledgeApi.remove('id', '3');

  const list = parseKnowledgeList(input);

  // @ts-expect-error Список записей может быть пустым.
  list.items[0].title.toLowerCase();

  void [unchecked, revision];
}

void checkContracts;
