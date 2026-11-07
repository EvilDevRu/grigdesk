import { translate } from '../../../../shared/i18n/catalogs.ts';

import { GLM_MODEL_ERROR_CODES } from './contract.ts';
import { glmAccessError } from './env.ts';

const MESSAGE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  AUTH: 'core.glmModelAuthFailed',
  QUOTA: 'core.glmModelQuotaUnavailable',
});

// Эти бизнес-коды Z.ai означают исчерпанное окно, хотя HTTP 429 и Harness
// могут обозначить их как RATE_LIMIT. Частота 1302 и перегрузка 1305 сюда не входят.
const USAGE_LIMIT_CODES = new Set(['1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321']);

/**
 * Публичная ошибка содержит собственное пояснение и только подтверждённые числовые коды.
 * Тело провайдера не переносится в чат: в нём могут оказаться ключи, пути и личные данные.
 */
export function classifyGlmModelError(failure: Record<string, unknown>, locale = 'ru'): Error | null {
  const harnessKind = String(failure.code || '');
  const text = String(failure.message || '');
  const providerCode = /"code"\s*:\s*"?(\d+)"?\s*[,}]/u.exec(text)?.[1] ?? '';
  const usageLimit = harnessKind !== 'AUTH' && USAGE_LIMIT_CODES.has(providerCode);
  const kind = harnessKind !== 'AUTH' && (usageLimit || providerCode === '1113') ? 'QUOTA' : harnessKind;
  const code = GLM_MODEL_ERROR_CODES[kind];

  if (!code) {
    return null;
  }

  const balanceUnavailable = kind === 'QUOTA' && providerCode === '1113';
  const key = usageLimit ? 'core.glmModelUsageLimitReached'
    : balanceUnavailable ? 'core.glmModelBalanceUnavailable' : MESSAGE_KEYS[kind]!;
  const status = /^\s*([1-5]\d{2})(?:\s*:|\s+\{)/u.exec(text)?.[1];

  return glmAccessError(code, translate(key, {
    http: status ? `HTTP ${status}, ` : '',
    code: providerCode,
  }, locale));
}
