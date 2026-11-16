import { record } from './transport.ts';

type PermissionAsk = (question: Record<string, unknown>) => Promise<unknown>;

/**
 * Native-вопрос сохраняет отдельные ответы, мультивыбор и произвольный текст.
 * Ключи совпадают с индексами вопросов ACP, а не с их изменяемыми заголовками.
 */
function questionAnswers(value: unknown, count: number): Record<string, string> {
  const decision = record(value);
  const raw = Array.isArray(decision.rawAnswers) ? decision.rawAnswers : [];
  const answers: Record<string, string> = {};

  for (let index = 0; index < count; index += 1) {
    const answer = record(raw[index]);
    const selected = Array.isArray(answer.selected)
      ? answer.selected.filter((item): item is string => typeof item === 'string') : [];
    const ownText = typeof answer.text === 'string' ? answer.text.trim() : '';
    const text = [...selected, ownText].filter(Boolean).join(', ');

    if (text) {
      answers[String(index)] = text;
    }
  }

  return answers;
}

/**
 * Общая карточка GrigDesk обслуживает native permissions, вопросы и утверждение плана.
 * Ответ выбирается только среди предложенных CLI вариантов и теряет силу после отмены.
 */
export async function qwenPermissionResponse(value: unknown, context: {
  ask?: PermissionAsk;
  signal?: AbortSignal;
  factory: boolean;
  planExecutionMode?: string;
}): Promise<Record<string, unknown>> {
  const params = record(value);
  const tool = record(params.toolCall);
  const meta = record(tool._meta);
  const name = String(meta.toolName || tool.title || '');
  const options = Array.isArray(params.options) ? params.options.map(record) : [];
  const rawQuestions = Array.isArray(meta.qwenQuestions) ? meta.qwenQuestions.map(record) : [];
  const isQuestion = meta.qwenInteractionKind === 'user_question' && rawQuestions.length > 0;
  const isPlan = name === 'exit_plan_mode';
  const input = record(tool.rawInput);
  const questions = rawQuestions.map((question) => ({
    ...question,
    multiSelect: question.multiSelect === true,
    allowFreeText: true,
  }));
  let decision: Record<string, unknown> = {};

  if (!context.factory && context.ask && !context.signal?.aborted) {
    decision = record(await context.ask({
      ...tool,
      name,
      tool: isPlan ? 'ExitPlanMode' : name,
      input: {
        ...input,
        kind: tool.kind,
        ...(isPlan ? {
          plan: input.plan,
          choices: options.filter((option) => option.kind !== 'reject_once').map((option) => ({
            id: option.optionId,
            label: option.name,
            kind: option.kind,
          })),
        } : {}),
      },
      ...(isQuestion ? {
        isQuestion: true,
        questions,
        source: 'Qwen',
        acceptsText: true,
      } : {}),
      acceptsComment: false,
      canRemember: false,
      // CLI уже применил свой режим и native-классификатор перед reverse request.
      // Общая автоматика GrigDesk не переоценивает запрошенное им решение человека.
      requiresExplicitUser: true,
      signal: context.signal,
    }));
  }

  const answers = isQuestion ? questionAnswers(decision, questions.length) : {};
  const requestedChoice = typeof decision.choice === 'string'
    ? options.find((option) => option.optionId === decision.choice) : undefined;
  const allowed = !context.signal?.aborted && !context.factory && requestedChoice?.kind !== 'reject_once'
    && (isQuestion ? Object.keys(answers).length === questions.length : decision.allow === true);
  const preferred = allowed ? options.find((option) => option.optionId === 'proceed_once') : undefined;
  const selected = (allowed ? requestedChoice || preferred : undefined)
    || options.find((option) => option.kind === (allowed ? 'allow_once' : 'reject_once'));

  return {
    outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' },
    ...(isQuestion && allowed ? { answers } : {}),
    ...(allowed && selected?.optionId === 'restore_previous' && context.planExecutionMode
      ? { expectedPlanExecutionMode: context.planExecutionMode } : {}),
  };
}
