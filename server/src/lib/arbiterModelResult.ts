import {
  ARBITER_LIMITS,
  ArbiterConversationError,
  arbiterRecord,
  arbiterText,
  decodeArbiterResult,
} from '../../../shared/pipeline/arbiterConversation.ts';
import type { ArbiterTarget } from '../../../shared/pipeline/arbiterConversation.ts';

/**
 * Вариант вопроса модели может содержать пояснение, которое не участвует в выборе.
 * Удаляется только проверенное текстовое description; остальные поля проверит строгий декодер.
 */
function modelQuestion(value: unknown) {
  const question = arbiterRecord(value, ['id', 'text', 'options', 'allowCustom']);
  const options = Array.isArray(question.options) ? question.options.map((value) => {
    const option = arbiterRecord(value, ['id', 'label'], ['description']);

    if (Object.hasOwn(option, 'description')) {
      arbiterText(option.description, ARBITER_LIMITS.summary, true);
    }

    return { id: option.id, label: option.label };
  }) : question.options;

  return { ...question, options };
}

/**
 * Отсутствующее пояснение берётся из уже предложенного ожидаемого результата.
 * Action, его цель и указание сохраняются целиком для прежней проверки без догадок.
 */
function modelProposal(value: unknown) {
  const proposal = arbiterRecord(value, [
    'id', 'kind', 'label', 'recommended', 'expectedResult',
  ], ['explanation', 'diagnosticInstruction', 'action']);

  return {
    ...proposal,
    explanation: Object.hasOwn(proposal, 'explanation') ? proposal.explanation : proposal.expectedResult,
  };
}

/**
 * Только граница модели допускает известные отклонения оформления ответа.
 * Durable/API-контракт остаётся строгим; ошибочный JSON и исполняемые поля не публикуются.
 */
export function parseArbiterModelResult(
  text: string,
  targets: readonly ArbiterTarget[],
  currentNode: string,
) {
  try {
    const raw = arbiterRecord(JSON.parse(text), ['summary', 'questions', 'proposals', 'technicalDetails']);
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
