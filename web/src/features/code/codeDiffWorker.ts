import { computeCodeDiff } from './codeDiffModel';
import type { DiffPreferences, DiffResult } from './codeDiffModel';

export type DiffWorkerRequest = {
  generation: number;
  oldContent: string;
  newContent: string;
  preferences: Pick<DiffPreferences, 'detail' | 'whitespace'>;
};
export type DiffWorkerResponse = {
  generation: number;
  result?: DiffResult;
  error?: string;
};

/**
 * Вычисление изолировано от UI; каждый ответ сохраняет поколение запроса.
 * Ошибка или таймаут никогда не превращаются в успешное сравнение без различий.
 */
self.addEventListener('message', (event: MessageEvent<DiffWorkerRequest>) => {
  const request = event.data;
  let response: DiffWorkerResponse;

  try {
    response = {
      generation: request.generation,
      result: computeCodeDiff(request.oldContent, request.newContent, request.preferences),
    };
  } catch (error) {
    response = {
      generation: request.generation,
      error: error instanceof Error ? error.message : 'diff_failed',
    };
  }

  self.postMessage(response);
});
