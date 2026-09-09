import { createKnowledgeBroker } from '../../server/src/lib/search/broker.ts';
import { normalizedTokens, stemWord } from '../../server/src/lib/search/normalize.ts';
import { parseKnowledgeSearchPreflight } from '../../server/src/lib/search/runtimePreflightClient.ts';
import { runKnowledgeCli } from '../../server/src/lib/search/cli.ts';
import { KnowledgeError } from '../../server/src/lib/search/errors.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type TokensAreChecked = Checked<IsUnchecked<ReturnType<typeof normalizedTokens>>>;
export type PreflightIsChecked = Checked<
  IsUnchecked<ReturnType<typeof parseKnowledgeSearchPreflight>>
>;
export type ErrorIsChecked = Checked<IsUnchecked<KnowledgeError['code']>>;

/**
 * Границу движка знаний держат три вещи: область работы агента, отчёт о среде и
 * код отказа хранилища. Ни одна не должна принимать чужую форму от соседнего
 * JavaScript — иначе агент прочитает чужой проект, а «проверить не удалось»
 * станет неотличимо от «всё готово».
 */
async function checkSearchContracts(input: unknown): Promise<void> {
  const broker = createKnowledgeBroker({});

  // @ts-expect-error Исход операции говорит кодом отказа, а не свободным текстом.
  (await broker.invoke({}, { action: 'search' })).error.toUpperCase();
  // @ts-expect-error Разбор запроса отдаёт список основ, а не одну строку.
  normalizedTokens(input).trim();
  // @ts-expect-error Основа слова — строка: числовой длины у неё нет.
  const stem: number = stemWord(input);
  // @ts-expect-error У отчёта о среде проверки лежат списком, а не числом.
  parseKnowledgeSearchPreflight(input).checks.toFixed();
  // @ts-expect-error CLI отвечает кодом возврата, а не текстом.
  const code: string = await runKnowledgeCli([]);

  void [code, stem];
}

void checkSearchContracts;
