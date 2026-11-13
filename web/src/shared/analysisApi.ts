import { objectOrEmpty } from '../../../shared/lib/objects.ts';

import { api } from './apiClient.ts';
import {
  parseAnalysisArbiter,
  parseAnalysisClarifications,
  parseAnalysisDetail,
  parseAnalysisQueue,
  parseAnalysisRows,
} from '../../../shared/pipeline/analysisContracts.ts';
import type { AnalysisAnswerInput } from '../../../shared/pipeline/analysisContracts.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


function taskPath(id: string | number, suffix = ''): string {
  return `/api/tasks/${encodeURIComponent(String(id))}${suffix}`;
}

/**
 * Единственная граница сети триажа. Оценку пишет модель, а показывают её бейджем на
 * доске и чипами в карточке: непроверенная форма превратилась бы в «сложность
 * undefined» ровно там, где человек принимает решение брать задачу или нет.
 */
export const analysisApi = {
  async rows() {
    const value: unknown = await api.get('/api/analysis');

    return parseAnalysisRows(value);
  },

  async detail(id: string | number) {
    const value: unknown = await api.get(`/api/analysis/${encodeURIComponent(String(id))}`);

    return parseAnalysisDetail(value);
  },

  async enqueue(id: string | number, source?: string, options?: { headers?: Record<string, string> }) {
    const value: unknown = await api.post(taskPath(id, '/analyze'), source ? { source } : undefined, options);

    return parseAnalysisQueue(value);
  },

  async dismiss(id: string | number) {
    const value: unknown = await api.del(`/api/analysis/${encodeURIComponent(String(id))}/status`);

    return parseAnalysisQueue(value);
  },

  async clarifications(id: string | number) {
    const value: unknown = await api.get(taskPath(id, '/clarifications'));

    return parseAnalysisClarifications(value);
  },

  /**
   * Ответы человека на вопросы триажа. `text` уезжает вместе с ними как читаемая
   * копия: файл уточнений открывают и глазами, и следующим заходом агента.
   */
  async answer(id: string | number, answers: AnalysisAnswerInput[], text: string) {
    const value: unknown = await api.post(taskPath(id, '/clarifications'), { answers, text });

    return parseAnalysisClarifications(value);
  },

  async arbitrate(id: string | number) {
    const value: unknown = await api.post(taskPath(id, '/analysis/arbitrate'), {});

    return parseAnalysisArbiter(value);
  },
};

/**
 * Выключенный плагин отвечает своим кодом и приезжает и в теле ответа, и в поле
 * ошибки транспорта. Раздел различает его с поломкой: это штатное состояние.
 */
export function analysisDisabledFailure(error: unknown): boolean {
  const failure = objectOrEmpty(error);

  return failure.code === 'plugin_disabled'
    || objectOrEmpty(failure.data).error === 'plugin_disabled';
}

/**
 * Текст отказа для человека. Сервер триажа отдаёт машинный код, а обрыв сети приходит
 * без тела вовсе — тогда остаётся сообщение самой ошибки.
 */
export function analysisErrorMessage(error: unknown, fallback = translateUi(
  'core.analysisApiTriageIsUnavailable',
)): string {
  const message = objectOrEmpty(error).message;

  return typeof message === 'string' && message ? message : fallback;
}
