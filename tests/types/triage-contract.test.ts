import type { Analysis, AnalysisRow, AnalysisStatus } from '../../shared/analysisContracts.ts';
import { parseAnalysisRows } from '../../shared/analysisContracts.ts';
import { analysisApi } from '../../web/src/shared/analysisApi.ts';
import { analyzeTask, dismissAnalysis, useAnalysisStore } from '../../web/src/actions/analysis';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type RowIsChecked = Checked<IsUnchecked<AnalysisRow>>;
export type StatusIsChecked = Checked<IsUnchecked<AnalysisStatus>>;
export type ApiRowsIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof analysisApi.rows>>>>;

/**
 * Примеры запускает только компилятор. Оценку пишет модель, а по ней человек решает,
 * брать ли задачу: непроверенный JSON не имеет права стать бейджем на доске.
 */
function checkContracts(input: unknown, store: ReturnType<typeof useAnalysisStore>): void {
  // @ts-expect-error Непроверенный JSON не является сводкой триажа.
  const unchecked: AnalysisRow[] = input;
  // @ts-expect-error Состояние очереди ограничено объявленным перечислением.
  const state: AnalysisStatus['state'] = 'думает';
  // @ts-expect-error Сложность приходит числом, а не словом интерфейса.
  const complexity: Analysis['complexity'] = 'высокая';
  // @ts-expect-error Ответ человека называет вопрос, к которому он относится.
  analysisApi.answer('42', [{ text: 'да' }], 'да');
  // @ts-expect-error Постановка в очередь называет задачу.
  analyzeTask();
  // @ts-expect-error Снятие статуса называет задачу.
  dismissAnalysis();
  // @ts-expect-error Стор состояния сам в сеть не ходит.
  store.load();

  const rows = parseAnalysisRows(input);

  // @ts-expect-error Сводка может быть пустой.
  rows[0].task.toFixed();
  // @ts-expect-error Оценки у поставленной в очередь задачи ещё нет.
  rows[0]?.analysis.complexity;

  void [unchecked, state, complexity];
}

void checkContracts;
