// Сигнал сбоя Codex app-server. Окончательный исход приходит в `turn/completed: failed`
// как `TurnError`; сетевой статус может лежать внутри `codexErrorInfo` (объект с одним
// ключом) — здесь он разворачивается в общий сигнал реестра, чтобы ядро не знало про Codex.
import type { TurnFailureRule, TurnFailureSignal } from '../chat/turnFailures.ts';

export const CODEX_TURN_FAILURE_RULES: readonly TurnFailureRule[] = Object.freeze([
  {
    id: 'codex.unauthorized',
    kind: 'auth',
    codes: Object.freeze(['unauthorized']),
  },
  {
    id: 'codex.usage-limit',
    kind: 'usage_limit',
    codes: Object.freeze(['usageLimitExceeded', 'sessionBudgetExceeded']),
  },
  {
    id: 'codex.context-window',
    kind: 'context_overflow',
    codes: Object.freeze(['contextWindowExceeded']),
  },
  {
    id: 'codex.policy',
    kind: 'policy',
    codes: Object.freeze([
      'cyberPolicy',
      'misalignmentPolicyViolation',
      'tooManyDenials',
    ]),
  },
  {
    id: 'codex.bad-request',
    kind: 'bad_request',
    codes: Object.freeze([
      'badRequest',
      'threadRollbackFailed',
      'sandboxError',
      'activeTurnNotSteerable',
    ]),
  },
  {
    id: 'codex.rate-limit',
    kind: 'rate_limited',
    codes: Object.freeze(['rateLimitExceeded']),
  },
  {
    id: 'codex.overloaded',
    kind: 'overloaded',
    codes: Object.freeze(['serverOverloaded', 'flexUnavailable']),
  },
  {
    id: 'codex.server-error',
    kind: 'server_error',
    codes: Object.freeze(['internalServerError']),
  },
  {
    id: 'codex.transport',
    kind: 'network',
    codes: Object.freeze([
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected',
      'responseTooManyFailedAttempts',
    ]),
  },
]);

/**
 * Разворачивает `codexErrorInfo` в код и статус. Строковая форма несёт только имя причины,
 * объектная — ровно один ключ плюс `httpStatusCode`; остальные формы (в том числе `other`
 * и `null`) кода не дают, и сбой решают общие слова реестра.
 */
function codexErrorFields(value: unknown): { code?: string; status?: number } {
  if (typeof value === 'string' && value) {
    return { code: value };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const key = Object.keys(value as Record<string, unknown>)[0];

  if (!key) {
    return {};
  }

  const detail = (value as Record<string, unknown>)[key];
  const status = detail && typeof detail === 'object'
    ? (detail as Record<string, unknown>).httpStatusCode
    : undefined;

  return {
    code: key,
    ...(Number.isInteger(status) && (status as number) > 0 ? { status: status as number } : {}),
  };
}

/**
 * Общий сигнал из `TurnError` (или строки). Текст НЕ обрезается: решение принимается по
 * полному сообщению, а усечение до классификации потеряло бы фатальную часть; длинный
 * сигнал закроется в unknown по правилу реестра уже после решения.
 */
export function codexTurnFailure(value: unknown): TurnFailureSignal {
  if (typeof value === 'string') {
    return { message: value };
  }

  if (!value || typeof value !== 'object') {
    return { message: 'ход завершился ошибкой' };
  }

  const error = value as Record<string, unknown>;
  const fields = codexErrorFields(error.codexErrorInfo);
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  const details = typeof error.additionalDetails === 'string' ? error.additionalDetails.trim() : '';
  const text = [message, details].filter(Boolean).join(': ');

  return {
    ...fields,
    message: text || 'ход завершился ошибкой',
  };
}
