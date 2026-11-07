// Сигнал сбоя Claude Code. CLI сочиняет synthetic-сообщение от имени модели
// (`message.model === '<synthetic>'`) и кладёт туда корневое поле `error` со своим кодом;
// статус HTTP приходит только внутри текста («API Error: 529 …»). Здесь эти поля
// сводятся к общему сигналу реестра, чтобы ядро не знало про Claude.
import type { TurnFailureRule, TurnFailureSignal } from '../chat/turnFailures.ts';

export const CLAUDE_TURN_FAILURE_RULES: readonly TurnFailureRule[] = Object.freeze([
  {
    id: 'claude.auth',
    kind: 'auth',
    codes: Object.freeze([
      'authentication_failed',
      'oauth_org_not_allowed',
      'account_on_hold',
      'verification_required',
      'cloud_credential_error',
    ]),
  },
  {
    id: 'claude.login',
    kind: 'auth',
    pattern: /please run \/login|invalid api key/i,
  },
  {
    id: 'claude.billing',
    kind: 'usage_limit',
    codes: Object.freeze(['billing_error']),
  },
  {
    id: 'claude.invalid-request',
    kind: 'bad_request',
    codes: Object.freeze(['invalid_request', 'model_not_found']),
  },
  {
    id: 'claude.rate-limit',
    kind: 'rate_limited',
    codes: Object.freeze(['rate_limit']),
  },
  {
    id: 'claude.overloaded',
    kind: 'overloaded',
    codes: Object.freeze(['overloaded']),
  },
  {
    id: 'claude.server-error',
    kind: 'server_error',
    codes: Object.freeze(['server_error']),
  },
  {
    id: 'claude.unable-to-connect',
    kind: 'network',
    pattern: /unable to connect to api/i,
  },
]);

/**
 * Общий сигнал из последнего synthetic-сообщения Claude. Код берётся из корневого `error`,
 * статус — из начала «API Error: NNN»; пустые поля не кладутся: отсутствие кода означает
 * отсутствие знания, а не код, и общие слова должны решать сбой сами.
 */
export function claudeTurnFailure(text: string, errorCode: unknown): TurnFailureSignal {
  const message = String(text ?? '');
  const status = /^API Error: (\d{3})\b/u.exec(message);
  const code = typeof errorCode === 'string' && errorCode ? errorCode : '';

  return {
    ...(code ? { code } : {}),
    ...(status ? { status: Number(status[1]) } : {}),
    message,
  };
}
