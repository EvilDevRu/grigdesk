import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import { openKnowledgeStorage } from './storage.js';

function serializedError(error) {
  return {
    message: String(error?.message || 'Хранилище знаний недоступно.'),
    code: error?.code,
    reasonCode: error?.reasonCode,
    currentRevision: error?.currentRevision,
  };
}

if (!isMainThread) {
  let storagePromise;
  let queue = Promise.resolve();
  const storage = () => {
    storagePromise ||= openKnowledgeStorage(workerData);
    return storagePromise;
  };

  parentPort.on('message', (request) => {
    queue = queue.then(async () => {
      try {
        const value = await storage();
        const operation = value?.[request.method];
        if (typeof operation !== 'function') {
          throw new Error('Неизвестная операция хранилища знаний.');
        }
        const result = await operation.apply(value, request.args || []);
        parentPort.postMessage({ id: request.id, result });
      } catch (error) {
        parentPort.postMessage({ id: request.id, error: serializedError(error) });
      }
    });
  });
}
