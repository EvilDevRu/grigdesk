import { normalizeAnalysisQuestions } from '../../server/src/lib/analysis/analyzer.ts';
import type { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { resolveDepth, resolveRoute } from '../../server/src/lib/analysis/routePolicy.ts';
import type { AnalysisModuleOptions } from '../../server/src/modules/analysis/index.ts';
import type { AnalysisAnswerInput } from '../../shared/pipeline/analysisContracts.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type QuestionsAreChecked = Checked<IsUnchecked<ReturnType<typeof normalizeAnalysisQuestions>>>;
export type DepthIsChecked = Checked<IsUnchecked<ReturnType<typeof resolveDepth>>>;
export type ListIsChecked = Checked<IsUnchecked<
  Awaited<ReturnType<AnalysisModuleOptions['analyzer']['list']>>
>>;

/**
 * Глубину маршрута считает политика, а не модель: её решение — объявленная ступень,
 * и соседний JavaScript не должен превращать его в свободную строку.
 */
async function checkServerContracts(analyzer: Analyzer): Promise<void> {
  // @ts-expect-error Ступень глубины закрыта перечислением политики.
  const depth: ReturnType<typeof resolveDepth>['depth'] = 'быстрый';
  // @ts-expect-error Постановка в очередь называет задачу.
  analyzer.enqueue();
  // @ts-expect-error Ответы человека приходят списком.
  analyzer.appendClarificationBatch('42', { questionId: 'q-1' });

  // Запрос называет выбор optionIds; `selection` — поле сохранённой записи, и
  // клиент, назвавший его так, отправил бы ответ без выбора вовсе.
  const request: AnalysisAnswerInput = { questionId: 'q-1', optionIds: ['o-1'] };
  // @ts-expect-error Имя поля сохранённой записи в запросе не принимается.
  const wrong: AnalysisAnswerInput = { questionId: 'q-1', selection: ['o-1'] };

  void request;
  void wrong;

  const decision = resolveRoute({ complexity: 1, risk: 1, diff_size: 'S' }, { routes: [] });

  // @ts-expect-error Маршрута может не быть: карта профиля его не обещает.
  decision.route.toLowerCase();

  const questions = normalizeAnalysisQuestions(['вопрос строкой']);

  // @ts-expect-error Список вопросов может быть пустым.
  questions[0].text.toLowerCase();

  void depth;
}

void checkServerContracts;
