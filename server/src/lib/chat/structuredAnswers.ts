import { isRecord } from '../../../../shared/lib/objects.ts';

const MAX_ANSWERS = 50;
const MAX_TEXT_LENGTH = 4_000;

// Вопрос агента с серверной схемой: подписи и ограничения берутся из pending-запроса.
export interface StructuredQuestion {
  key: string;
  inputType?: string;
  required?: boolean;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  options?: Array<{ value?: unknown }>;
}

// Ответ человека: браузер присылает только пары key/value.
export interface StructuredAnswer {
  key: string;
  value: unknown;
}

// Итог проверки: либо нормализованные ответы, либо код отказа.
export type StructuredAnswersResult =
  | { ok: true; answers: StructuredAnswer[] }
  | { ok: false; error: string };

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf())
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

function validFormat(format: string | undefined, value: string): boolean {
  if (!format) return true;
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === 'uri') {
    try {
      const uri = new URL(value);
      return !!uri.protocol;
    } catch {
      return false;
    }
  }
  if (format === 'date') return validDate(value);
  if (format === 'date-time') {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && !Number.isNaN(Date.parse(value));
  }
  return false;
}

/**
 * Значение проверяется только по серверной схеме, а не по присланным UI-подписям.
 * Свободный текст рядом с choice имеет отдельный ограниченный codec без ослабления enum.
 */
function validValue(question: StructuredQuestion, value: unknown): boolean {
  if (question.inputType === 'choice-or-text') {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH
      && (question.maxLength === undefined || value.length <= question.maxLength);
  }
  if (question.inputType === 'text') {
    if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) return false;
    if (question.minLength !== undefined && value.length < question.minLength) return false;
    if (question.maxLength !== undefined && value.length > question.maxLength) return false;
    return validFormat(question.format, value);
  }
  if (question.inputType === 'number' || question.inputType === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (question.inputType === 'integer' && !Number.isInteger(value)) return false;
    if (question.minimum !== undefined && value < question.minimum) return false;
    if (question.maximum !== undefined && value > question.maximum) return false;
    return true;
  }
  if (question.inputType === 'boolean') return typeof value === 'boolean';

  const allowed = new Set((question.options || []).map((option) => option.value));
  if (question.inputType === 'choice') {
    return typeof value === 'string' && allowed.has(value);
  }
  if (question.inputType === 'multi-choice') {
    if (!Array.isArray(value) || value.length > 100) return false;
    if (!value.every((entry) => typeof entry === 'string' && allowed.has(entry))) return false;
    if (new Set(value).size !== value.length) return false;
    if (question.minItems !== undefined && value.length < question.minItems) return false;
    if (question.maxItems !== undefined && value.length > question.maxItems) return false;
    return true;
  }
  return false;
}

/**
 * Проверяет typed-ответы на доверенной серверной схеме. Браузер присылает только
 * пары key/value: подписи и ограничения берутся из pending-запроса, а не из POST.
 */
export function validateStructuredAnswers(
  questions: unknown,
  answers: unknown,
): StructuredAnswersResult {
  if (!Array.isArray(questions) || questions.length > MAX_ANSWERS) {
    return { ok: false, error: 'invalid_questions' };
  }
  if (!Array.isArray(answers) || answers.length > MAX_ANSWERS) {
    return { ok: false, error: 'invalid_answers' };
  }

  const expected = new Map<string, StructuredQuestion>();
  for (const question of questions as StructuredQuestion[]) {
    if (!isRecord(question) || typeof question.key !== 'string' || !question.key
      || expected.has(question.key)) {
      return { ok: false, error: 'invalid_questions' };
    }
    expected.set(question.key, question);
  }

  const seen = new Set<string>();
  const normalized: StructuredAnswer[] = [];
  for (const answer of answers as StructuredAnswer[]) {
    if (!isRecord(answer) || typeof answer.key !== 'string' || seen.has(answer.key)) {
      return { ok: false, error: 'invalid_answers' };
    }
    const question = expected.get(answer.key);
    if (!question || !Object.hasOwn(answer, 'value')) {
      return { ok: false, error: 'invalid_answers' };
    }
    seen.add(answer.key);
    if (!validValue(question, answer.value)) {
      return { ok: false, error: 'invalid_answer_value' };
    }
    normalized.push({ key: question.key, value: answer.value });
  }

  for (const question of questions as StructuredQuestion[]) {
    if (question.required && !seen.has(question.key)) {
      return { ok: false, error: 'required_answer_missing' };
    }
  }
  return { ok: true, answers: normalized };
}
