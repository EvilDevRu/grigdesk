// Сигнал сбоя DSH (DeepSeek и GLM). Ошибка модели приходит в `turn/end` как
// `reason.error` с кодом; здесь он сводится к общему сигналу реестра, чтобы ядро
// не знало про DSH, а внутренние повторы самого DSH оставались нетронутыми.
import type { TurnFailureRule, TurnFailureSignal } from '../chat/turnFailures.ts';

export const DSH_TURN_FAILURE_RULES: readonly TurnFailureRule[] = Object.freeze([
  {
    id: 'dsh.auth',
    kind: 'auth',
    codes: Object.freeze(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']),
  },
  {
    id: 'dsh.quota',
    kind: 'usage_limit',
    codes: Object.freeze(['QUOTA']),
  },
  {
    id: 'dsh.context-window',
    kind: 'context_overflow',
    codes: Object.freeze(['CONTEXT_WINDOW_EXCEEDED']),
  },
  {
    id: 'dsh.rate-limit',
    kind: 'rate_limited',
    codes: Object.freeze(['RATE_LIMIT']),
  },
  {
    id: 'dsh.server',
    kind: 'server_error',
    codes: Object.freeze(['SERVER', 'EMPTY_RESPONSE']),
  },
  {
    id: 'dsh.transport',
    kind: 'network',
    codes: Object.freeze(['TRANSPORT', 'TIMEOUT']),
  },
]);

/**
 * Общий сигнал из `turn/end.reason.error`. Код берётся только непустой строкой, статус —
 * целым положительным; пустые поля не кладутся, иначе отсутствие знания превратилось бы
 * в код и увело сбой мимо общих слов. Текст подменяется запасной подписью кокпита.
 */
export function dshTurnFailure(
  failure: Record<string, unknown>,
  fallback?: string,
): TurnFailureSignal {
  const code = typeof failure?.code === 'string' && failure.code ? failure.code : '';
  const status = Number(failure?.status);
  const message = String(failure?.message || fallback || '');

  return {
    ...(code ? { code } : {}),
    ...(Number.isInteger(status) && status > 0 ? { status } : {}),
    message,
  };
}
