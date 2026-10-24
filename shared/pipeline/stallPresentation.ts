import { isRecord } from '../lib/objects.ts';

export interface StallDetails {
  what: string;
  cause?: string;
  retained?: string;
  action?: string;
}

export interface StallPresentation {
  reason: string;
  summary: string;
  details: StallDetails;
  attempts?: number;
  returns?: number;
  lastFailure?: string;
  model?: string;
}

const FAILURE_LABELS: Record<string, string> = {
  unknown: 'причина не названа',
  timeout: 'убит по лимиту времени этапа',
  missing_status: 'не выставил статус',
  crashed: 'процесс упал',
};

/**
 * Переводит отдельный класс движка, сохраняя свободное сообщение провайдера.
 * Исходный машинный результат и журнал этим преобразованием не меняются.
 */
export function stallFailureLabel(value: string): string {
  return FAILURE_LABELS[value.trim()] || value.trim();
}

/**
 * Старый сервер может прислать заготовку пути или отдельный класс сбоя в подписи.
 * Запасное представление убирает только известные шаблоны, не режет человеческую прозу.
 */
export function normalizeStallText(value: string): string {
  return value
    .replace(/([Чч]ерновик(?: хода)?\s+)?t<TASK>\.<этап>\.checkpoint\.md/gu,
      (_match, prefix: string | undefined) => prefix?.trim() || 'черновик хода')
    .replace(/(?:logs\/)?tNNNN\.(?:stages|orch|route-v2)\.log/gu, 'журнал этапов')
    .replace(/последний — (unknown|timeout|missing_status|crashed)(?=$|[\s,;.])/gu,
      (_match, failure: string) => `последний — ${stallFailureLabel(failure)}`);
}

/**
 * Необязательное расширение не участвует в приёмке всего снимка задач.
 * При неверной форме клиент использует прежние title/hint целиком.
 */
export function readStallPresentation(value: unknown): StallPresentation | null {
  if (!isRecord(value) || typeof value.reason !== 'string' || !value.reason.trim()
    || typeof value.summary !== 'string' || !value.summary.trim() || !isRecord(value.details)
    || typeof value.details.what !== 'string' || !value.details.what.trim()) {
    return null;
  }

  const strings = ['cause', 'retained', 'action'];
  const metrics = ['attempts', 'returns'];

  if (strings.some((key) => value.details && isRecord(value.details)
      && value.details[key] != null && typeof value.details[key] !== 'string')
    || metrics.some((key) => value[key] != null && !Number.isFinite(value[key]))
    || ['lastFailure', 'model'].some((key) => value[key] != null && typeof value[key] !== 'string')) {
    return null;
  }

  return value as unknown as StallPresentation;
}
