import { isRecord } from '../../../../shared/lib/objects.ts';
import { validateStructuredAnswers } from '../chat/structuredAnswers.ts';

/**
 * Вопросы получают стабильный native ID, а заголовки остаются только подписями.
 * Secret или неизвестная форма отклоняют весь запрос до UI и создания waiter.
 */
export function codexQuestionPresentation(params: unknown) {
  if (!isRecord(params) || typeof params.isBlocking !== 'boolean'
    || !Array.isArray(params.questions) || !params.questions.length || params.questions.length > 3) {
    return null;
  }

  const ids = new Set<string>();
  const questions = [];

  for (const raw of params.questions) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200
      || ids.has(raw.id) || typeof raw.header !== 'string' || raw.header.length > 4000
      || typeof raw.question !== 'string' || raw.question.length > 4000
      || typeof raw.isOther !== 'boolean' || raw.isSecret !== false
      || (raw.options !== null && (!Array.isArray(raw.options) || !raw.options.length
        || raw.options.length > 100))) {
      return null;
    }

    ids.add(raw.id);

    const options = raw.options === null ? [] : raw.options;

    if (!options.every((option) => isRecord(option) && typeof option.label === 'string'
      && option.label.length > 0 && option.label.length <= 4000
      && typeof option.description === 'string' && option.description.length <= 4000)
      || new Set(options.map((option) => option.label)).size !== options.length) {
      return null;
    }

    questions.push({
      key: raw.id,
      header: raw.header,
      question: raw.question,
      inputType: !options.length ? 'text' : raw.isOther ? 'choice-or-text' : 'choice',
      required: true,
      minLength: 1,
      maxLength: 4000,
      allowFreeText: !options.length || raw.isOther,
      options: options.map((option) => ({
        value: option.label,
        label: option.label,
        description: option.description
      })),
    });
  }

  return {
    tool: 'Вопрос агента',
    isQuestion: true,
    structured: true,
    structuredAnswers: true,
    requiresExplicitUser: true,
    canRemember: false,
    acceptsText: true,
    source: 'Codex',
    blocking: params.isBlocking,
    actions: ['accept', 'cancel'],
    questions
  };
}

/**
 * Только пары key/value проверяются по исходной серверной форме вопроса.
 * Подписи из UI и ответы другого native ID не становятся доверенными значениями.
 */
export function codexQuestionResponse(presentation: NonNullable<ReturnType<
  typeof codexQuestionPresentation>>, decision: unknown) {
  if (!isRecord(decision) || decision.action !== 'accept') {
    return { answers: {} };
  }

  const checked = validateStructuredAnswers(presentation.questions, decision.answers);

  if (!checked.ok) {
    return { answers: {} };
  }

  return { answers: Object.fromEntries(checked.answers.map((answer) => (
    [answer.key, { answers: [answer.value as string] }]
  ))) };
}

/**
 * Асинхронный вопрос приходит сообщением, без native ID отдельных вопросов.
 * Позиционные ключи сохраняют порядок и различают одинаковые заголовки внутри карточки.
 */
export function codexAsyncQuestionPresentation(item: unknown) {
  if (!isRecord(item) || item.delivery !== 'async' || !Array.isArray(item.questions)
    || !item.questions.length || item.questions.length > 3) {
    return null;
  }

  const questions = [];

  for (const [index, raw] of item.questions.entries()) {
    if (!isRecord(raw) || typeof raw.title !== 'string'
      || (raw.options != null && (!Array.isArray(raw.options)
        || !raw.options.every((option) => typeof option === 'string')))) {
      return null;
    }

    questions.push({
      id: `async-question-${index + 1}`,
      header: '',
      question: raw.title,
      isOther: true,
      isSecret: false,
      options: raw.options?.length
        ? raw.options.map((label: string) => ({ label, description: '' })) : null,
    });
  }

  return codexQuestionPresentation({ isBlocking: false, questions });
}

/**
 * Ответ проверяется по сохранённой карточке и передаётся в текущий ход обычным вводом.
 * Пропуск явно отличается от согласия; повреждённые ответы вообще не доставляются.
 */
export function codexAsyncQuestionResponse(presentation: NonNullable<ReturnType<
  typeof codexAsyncQuestionPresentation>>, decision: unknown): string | null {
  if (!isRecord(decision)) {
    return null;
  }

  if (decision.action === 'cancel') {
    return 'Пользователь пропустил вопросы агента. Ответ не получен; согласие на действия не дано.\n'
      + presentation.questions.map((question) => `• ${question.question}`).join('\n');
  }

  if (decision.action !== 'accept') {
    return null;
  }

  const checked = validateStructuredAnswers(presentation.questions, decision.answers);

  if (!checked.ok) {
    return null;
  }

  const answers = new Map(checked.answers.map((answer) => [answer.key, answer.value]));

  return 'Ответ пользователя на вопросы агента:\n'
    + presentation.questions.map((question) => (
      `• ${question.question}\nОтвет: ${answers.get(question.key)}`
    )).join('\n');
}
