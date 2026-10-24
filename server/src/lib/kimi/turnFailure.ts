import { recordOrEmpty } from '../../../../shared/lib/objects.ts';
import { trimmedText } from '../../../../shared/lib/text.ts';

import { classifyTurnFailure, TURN_FAILURE_LABELS } from '../chat/turnFailures.ts';
import type { TurnFailureRule, TurnFailureSignal } from '../chat/turnFailures.ts';

const KIMI_FAILURE_RULES: readonly TurnFailureRule[] = [
  {
    id: 'kimi.usage-limit',
    kind: 'usage_limit',
    codes: ['APIProviderQuotaExhaustedError'],
    pattern: /\b(?:reached|exceeded) your (?:[\w-]+ )?usage limit\b/i,
  },
];

/**
 * Отказ модели сохраняет её исходные код, статус и текст без отметки ручной остановки.
 * Квота распознаётся по явной причине Kimi; один HTTP 429 означает лишь частоту запросов.
 */
export function kimiTurnError(value: unknown, fallback: string): Error {
  const raw = recordOrEmpty(value);
  const details = recordOrEmpty(raw.details);
  const code = trimmedText(raw.code);
  const status = details.statusCode;
  const text = trimmedText(raw.message) || trimmedText(value) || fallback;
  const turnFailure: TurnFailureSignal = {
    ...(code ? { code } : {}),
    ...(typeof status === 'number' && Number.isSafeInteger(status) && status > 0 ? { status } : {}),
    message: text,
  };
  const verdict = classifyTurnFailure({
    ...turnFailure,
    ...(raw.name === 'APIProviderQuotaExhaustedError' ? { code: raw.name } : {}),
  }, KIMI_FAILURE_RULES);
  const message = verdict.kind === 'usage_limit'
    ? `${TURN_FAILURE_LABELS.usage_limit}: ${text}`
    : text;

  return Object.assign(new Error(message), {
    ...(code ? { code } : {}),
    turnFailure,
    failureKind: verdict.kind,
  });
}
