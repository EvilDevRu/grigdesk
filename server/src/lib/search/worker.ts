import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import { openKnowledgeStorage } from './storage.ts';

// Ошибка уезжает в главный поток структурой: чужой Error через postMessage
// теряет и код, и ревизию, а решение о конфликте принимается именно по ним.
function serializedError(error: unknown) {
  const failure = error as {
    message?: unknown;
    code?: unknown;
    reasonCode?: unknown;
    currentRevision?: unknown;
  } | null;

  return {
    message: String(failure?.message || 'Хранилище знаний недоступно.'),
    code: failure?.code,
    reasonCode: failure?.reasonCode,
    currentRevision: failure?.currentRevision,
  };
}

if (!isMainThread) {
  let storagePromise: Promise<Record<string, unknown>> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const storage = () => {
    storagePromise ||= openKnowledgeStorage(workerData) as Promise<Record<string, unknown>>;

    return storagePromise;
  };

  parentPort?.on('message', (request: { id: unknown; method: string; args?: unknown[] }) => {
    queue = queue.then(async () => {
      try {
        const value = await storage();
        const operation = value?.[request.method] as ((...args: unknown[]) => unknown) | undefined;

        if (typeof operation !== 'function') {
          throw new Error('Неизвестная операция хранилища знаний.');
        }

        const result = await operation.apply(value, request.args || []);

        parentPort?.postMessage({ id: request.id, result });
      } catch (error) {
        parentPort?.postMessage({ id: request.id, error: serializedError(error) });
      }
    });
  });
}
