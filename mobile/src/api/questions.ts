import type { Question, WaitingAnswer } from './contract.ts';

export type QuestionDraft = {
  optionIds: string[];
  text: string;
  value: string;
};

/**
 * Проверка охватывает типизированные ограничения, а на сервер отправляются устойчивые option ids.
 * Недопустимый обязательный ответ не превращается в пустую строку или ложное approve.
 */
export function questionAnswer(
  question: Question,
  draft: QuestionDraft,
): NonNullable<WaitingAnswer['answers']>[number] | null {
  const selected = draft.optionIds;
  const text = draft.text.trim();
  const typedValue = String(draft.value ?? '').trim();
  const limits = question.constraints;
  const answer: NonNullable<WaitingAnswer['answers']>[number] = { questionId: question.id };

  if (
    selected.some((id) => !question.options.some((option) => option.id === id)) ||
    (!question.multiSelect && selected.length > 1) ||
    selected.length < (limits.minItems ?? 0) ||
    selected.length > (limits.maxItems ?? 100)
  ) {
    return null;
  }
  if (question.options.length) {
    answer.optionIds = selected;
  }
  if (
    !['number', 'integer', 'boolean'].includes(question.inputType) &&
    (question.allowFreeText || (!question.options.length && question.inputType === 'text'))
  ) {
    answer.text = text;

    if (text.length < (limits.minLength ?? 0) || text.length > (limits.maxLength ?? 4000)) {
      return null;
    }
  }
  if (['number', 'integer'].includes(question.inputType)) {
    if (!typedValue) {
      return question.required ? null : answer;
    }

    const value = Number(typedValue);

    if (
      !Number.isFinite(value) ||
      (question.inputType === 'integer' && !Number.isInteger(value)) ||
      value < (limits.minimum ?? -Infinity) ||
      value > (limits.maximum ?? Infinity)
    ) {
      return null;
    }

    answer.value = value;
  } else if (question.inputType === 'boolean') {
    if (!['true', 'false'].includes(typedValue)) {
      return question.required ? null : answer;
    }

    answer.value = typedValue === 'true';
  }
  if (question.required && !selected.length && !text && answer.value === undefined) {
    return null;
  }

  return answer;
}
