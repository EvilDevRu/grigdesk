import knowledgeSearch from '../../server/src/lib/executors/work-tools/knowledgeSearch.ts';
import type { KnowledgeToolOptions } from '../../server/src/lib/executors/work-tools/knowledgeSearch.ts';
import type { KnowledgeModuleOptions } from '../../server/src/modules/knowledge/index.ts';
import type { KnowledgeRecord } from '../../shared/knowledgeContracts.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;
type ToolResult = Awaited<ReturnType<typeof knowledgeSearch.invoke>>;

export type ToolResultIsChecked = Checked<IsUnchecked<ToolResult>>;
export type StoreListIsChecked = Checked<IsUnchecked<
  Awaited<ReturnType<KnowledgeModuleOptions['knowledge']['list']>>
>>;

/**
 * Соседний JS не должен превращать собеседников модуля в непроверенные значения:
 * хранилище отвечает объявленной формой, а область рабочего tool-а задаёт сервер.
 */
async function checkServerContracts(
  options: KnowledgeModuleOptions,
  tool: KnowledgeToolOptions,
): Promise<void> {
  // @ts-expect-error Чтение отвечает записью или её отсутствием.
  const record: KnowledgeRecord = await options.knowledge.read('id');
  // @ts-expect-error Удаление сверяет ожидаемую ревизию и требует её параметром.
  options.knowledge.delete('id');
  // @ts-expect-error Экспорт резервной копии аргументов не принимает.
  options.transfer.exportKnowledge('id');

  const result = await knowledgeSearch.invoke(tool, { action: 'read', id: 'id' });

  if (result.ok) {
    // @ts-expect-error Успех поиска и успех чтения — разные формы ответа.
    result.items.length.toFixed();
  } else {
    result.error.toLowerCase();
  }

  void record;
}

void checkServerContracts;
