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

function taskPath(id: string | number, suffix = ''): string {
  return `/api/tasks/${encodeURIComponent(String(id))}${suffix}`;
}

/**
 * Пара источника и номера сохраняется в каждом запросе пакета триажа.
 * Старые вызовы без источника оставляют прежний URL числового API.
 */
function sourced(path: string, source?: string): string {
  return source ? `${path}?${new URLSearchParams({ source })}` : path;
}

/**
 * Единственная граница сети триажа. Оценку пишет модель, а показывают её бейджем на
 * доске и чипами в карточке: непроверенная форма превратилась бы в «сложность
 * undefined» ровно там, где человек принимает решение брать задачу или нет.
 */
export const analysisApi = {
  async rows() {
    const value: unknown = await api.get('/api/analysis?sources=1');

    return parseAnalysisRows(value);
  },

  async detail(id: string | number, source?: string) {
    const value: unknown = await api.get(sourced(`/api/analysis/${encodeURIComponent(String(id))}`, source));

    return parseAnalysisDetail(value);
  },

  async enqueue(id: string | number, source?: string, options?: { headers?: Record<string, string> }) {
    const value: unknown = await api.post(
      taskPath(id, '/analyze'), source ? { source, taskSource: source } : undefined, options,
    );

    return parseAnalysisQueue(value);
  },

  async dismiss(id: string | number, source?: string) {
    const value: unknown = await api.del(
      sourced(`/api/analysis/${encodeURIComponent(String(id))}/status`, source),
    );

    return parseAnalysisQueue(value);
  },

  async clarifications(id: string | number, source?: string) {
    const value: unknown = await api.get(sourced(taskPath(id, '/clarifications'), source));

    return parseAnalysisClarifications(value);
  },

  /**
   * Ответы человека на вопросы триажа. `text` уезжает вместе с ними как читаемая
   * копия: файл уточнений открывают и глазами, и следующим заходом агента.
   */
  async answer(id: string | number, answers: AnalysisAnswerInput[], text: string, source?: string) {
    const value: unknown = await api.post(
      sourced(taskPath(id, '/clarifications'), source), { answers, text },
    );

    return parseAnalysisClarifications(value);
  },

  async arbitrate(id: string | number, source?: string) {
    const value: unknown = await api.post(sourced(taskPath(id, '/analysis/arbitrate'), source), {});

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
export function analysisErrorMessage(error: unknown, fallback = 'Триаж недоступен'): string {
  const message = objectOrEmpty(error).message;

  return typeof message === 'string' && message ? message : fallback;
}
