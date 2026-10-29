import { translate } from '../../../../shared/i18n/catalogs.ts';

import { GLM_MODEL_ERROR_CODES } from './contract.ts';
import { glmAccessError } from './env.ts';

const MESSAGE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  AUTH: 'core.glmModelAuthFailed',
  QUOTA: 'core.glmModelQuotaUnavailable',
});

/**
 * Публичная ошибка содержит собственное пояснение и только подтверждённые числовые коды.
 * Тело провайдера не переносится в чат: в нём могут оказаться ключи, пути и личные данные.
 */
export function classifyGlmModelError(failure: Record<string, unknown>, locale = 'ru'): Error | null {
  const kind = String(failure.code || '');
  const code = GLM_MODEL_ERROR_CODES[kind];

  if (!code) {
    return null;
  }

  const text = String(failure.message || '');
  const balanceUnavailable = kind === 'QUOTA' && /"code"\s*:\s*"?1113"?\s*[,}]/u.test(text);
  const key = balanceUnavailable ? 'core.glmModelBalanceUnavailable' : MESSAGE_KEYS[kind]!;
  const status = /^\s*([1-5]\d{2})(?:\s*:|\s+\{)/u.exec(text)?.[1];

  return glmAccessError(code, translate(key, { http: status ? `HTTP ${status}, ` : '' }, locale));
}
