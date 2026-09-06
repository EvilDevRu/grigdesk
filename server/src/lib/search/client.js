import { Worker } from 'node:worker_threads';

import { KnowledgeError } from './errors.js';

function restoredError(value = {}) {
  return new KnowledgeError(value.message || 'Хранилище знаний недоступно.', value);
}

/**
 * Ленивый клиент держит SQLite вне Fastify event loop и отправляет операции в
 * единственную очередь worker-а. Упавшие мутации отклоняются и не повторяются.
 */
export function createKnowledgeClient({ dbPath, seedSamples = false } = {}) {
  let worker = null;
  let sequence = 0;
  let closed = false;
  const pending = new Map();

  function failPending(error) {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  }

  function ensureWorker() {
    if (closed) {
      throw new KnowledgeError('Клиент знаний уже закрыт.', {
        code: 'KNOWLEDGE_UNAVAILABLE',
        reasonCode: 'client_closed',
      });
    }
    if (worker) {
      return worker;
    }
    const current = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { dbPath, seedSamples },
    });
    worker = current;
    current.on('message', (message) => {
      const entry = pending.get(message.id);
      if (!entry) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        entry.reject(restoredError(message.error));
      } else {
        entry.resolve(message.result);
      }
    });
    current.once('error', (error) => {
      if (worker === current) {
        worker = null;
      }
      failPending(new KnowledgeError('Worker знаний завершился с ошибкой.', {
        code: 'KNOWLEDGE_UNAVAILABLE',
        reasonCode: 'worker_failed',
        cause: error,
      }));
    });
    current.once('exit', (code) => {
      if (worker === current) {
        worker = null;
      }
      if (!closed && code !== 0) {
        failPending(new KnowledgeError('Worker знаний недоступен.', {
          code: 'KNOWLEDGE_UNAVAILABLE',
          reasonCode: 'worker_exited',
        }));
      }
    });
    return current;
  }

  function call(method, ...args) {
    const current = ensureWorker();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      current.postMessage({ id, method, args });
    });
  }

  return {
    list: (input) => call('list', input),
    search: (input) => call('search', input),
    read: (id) => call('read', id),
    create: (input) => call('create', input),
    update: (id, input) => call('update', id, input),
    delete: (id, input) => call('delete', id, input),
    exportSnapshot: () => call('exportSnapshot'),
    previewImport: (records) => call('previewImport', records),
    applyImport: (records, resolutions) => call('applyImport', records, resolutions),
    async close() {
      closed = true;
      const current = worker;
      worker = null;
      failPending(new KnowledgeError('Клиент знаний закрыт.', {
        code: 'KNOWLEDGE_UNAVAILABLE',
        reasonCode: 'client_closed',
      }));
      await current?.terminate();
    },
  };
}

export default createKnowledgeClient;
