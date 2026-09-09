import { Worker } from 'node:worker_threads';

import { KnowledgeError } from './errors.ts';

type Payload = Record<string, unknown>;

function restoredError(value: Payload = {}): KnowledgeError {
  return new KnowledgeError(String(value.message || 'Хранилище знаний недоступно.'), value);
}

/**
 * Ленивый клиент держит SQLite вне Fastify event loop и отправляет операции в
 * единственную очередь worker-а. Упавшие мутации отклоняются и не повторяются.
 */
export function createKnowledgeClient({ dbPath, seedSamples = false }: {
  dbPath?: string;
  seedSamples?: boolean;
} = {}) {
  let worker: Worker | null = null;
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();

  function failPending(error: unknown): void {
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
    const current = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { dbPath, seedSamples },
    });

    worker = current;
    current.on('message', (message: { id: number; result?: unknown; error?: Payload }) => {
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
    current.once('error', (error: unknown) => {
      if (worker === current) {
        worker = null;
      }
      failPending(new KnowledgeError('Worker знаний завершился с ошибкой.', {
        code: 'KNOWLEDGE_UNAVAILABLE',
        reasonCode: 'worker_failed',
        cause: error,
      }));
    });
    current.once('exit', (code: number) => {
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

  function call(method: string, ...args: unknown[]): Promise<unknown> {
    const current = ensureWorker();
    const id = ++sequence;

    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      current.postMessage({ id, method, args });
    });
  }

  return {
    list: (input: unknown) => call('list', input),
    search: (input: unknown) => call('search', input),
    read: (id: unknown) => call('read', id),
    create: (input: unknown) => call('create', input),
    update: (id: unknown, input: unknown) => call('update', id, input),
    delete: (id: unknown, input: unknown) => call('delete', id, input),
    exportSnapshot: () => call('exportSnapshot'),
    previewImport: (records: unknown) => call('previewImport', records),
    applyImport: (records: unknown, resolutions: unknown) => (
      call('applyImport', records, resolutions)
    ),
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
