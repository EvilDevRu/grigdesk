import {
  ArbiterConversationError,
  arbiterRecord,
  decodeArbiterResult,
} from '../../../shared/pipeline/arbiterConversation.ts';
import type { ArbiterTarget } from '../../../shared/pipeline/arbiterConversation.ts';

/**
 * На границе модели выбирает известные поля, не сохраняя постороннее оформление.
 * Наличие обязательных полей и их значения по-прежнему проверяются строго.
 */
function modelRecord(value: unknown, required: string[], optional: string[] = []) {
  const keys = value && typeof value === 'object' ? Object.keys(value) : [];
  const source = arbiterRecord(value, required, keys);

  return Object.fromEntries([...required, ...optional]
    .filter((key) => Object.hasOwn(source, key))
    .map((key) => [key, source[key]]));
}

/**
 * Вопрос без allowCustom допускает свой ответ, как и канонический вопрос.
 * Дополнительные поля вопроса и вариантов не участвуют в выборе и удаляются.
 */
function modelQuestion(value: unknown) {
  const question = modelRecord(value, ['id', 'text', 'options'], ['allowCustom']);
  const options = Array.isArray(question.options)
    ? question.options.map((value) => modelRecord(value, ['id', 'label'])) : question.options;

  return {
    ...question,
    options,
    allowCustom: Object.hasOwn(question, 'allowCustom') ? question.allowCustom : true,
  };
}

/**
 * Пропущенное пояснение берётся из результата, пропущенная рекомендация означает false.
 * Явные значения не исправляются; action, цель и указание проверит строгий декодер.
 */
function modelProposal(value: unknown) {
  const proposal = modelRecord(value, [
    'id', 'kind', 'label', 'expectedResult',
  ], ['recommended', 'explanation', 'diagnosticInstruction', 'action']);

  return {
    ...proposal,
    recommended: Object.hasOwn(proposal, 'recommended') ? proposal.recommended : false,
    explanation: Object.hasOwn(proposal, 'explanation') ? proposal.explanation : proposal.expectedResult,
  };
}

/**
 * Только граница модели убирает посторонние поля и восполняет безопасные значения.
 * Durable/API-контракт и вложенный action остаются строгими; полномочия не расширяются.
 */
export function parseArbiterModelResult(
  text: string,
  targets: readonly ArbiterTarget[],
  currentNode: string,
) {
  try {
    const raw = arbiterRecord(JSON.parse(text),
      ['summary', 'questions', 'proposals', 'technicalDetails'], ['nextStep']);
    const questions = Array.isArray(raw.questions) ? raw.questions.map(modelQuestion) : raw.questions;
    const proposals = Array.isArray(raw.proposals) ? raw.proposals.map(modelProposal) : raw.proposals;

    return decodeArbiterResult({
      ...raw,
      questions,
      proposals,
    }, targets, currentNode);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ArbiterConversationError('bad_model_reply', 'Арбитр прислал итог с ошибкой JSON.');
    }

    if (error instanceof ArbiterConversationError) {
      throw new ArbiterConversationError('bad_model_reply',
        `Арбитр прислал некорректные варианты решения. ${error.message}`);
    }

    throw error;
  }
}
