import { Worker as NodeWorker } from 'node:worker_threads';

import { build } from '../../../web/node_modules/esbuild/lib/main.js';
import { webFile } from './compile-vue.js';

const activeWorkers = new Set();
let deliveryInterceptor = null;

/**
 * Запускает настоящий запланированный diff Worker в отдельном Node-потоке.
 * Подменён только транспорт браузера: вычисления и поколения остаются кодом продукта.
 */
export function installCodeReviewWorker(t) {
  const previous = globalThis.Worker;
  const instances = new Set();

  class BrowserWorker {
    constructor() {
      this.listeners = new Map();
      this.closed = false;
      this.pending = 0;
      instances.add(this);
      activeWorkers.add(this);
      this.ready = this.start();
    }

    /**
     * Бандл читается только при создании Worker компонентом, не при импорте тестов.
     * Поэтому отсутствие будущего файла не может стать исходной причиной RED.
     */
    async start() {
      try {
        const bundle = await build({
          entryPoints: [webFile('src/features/code/codeDiffWorker.ts')],
          bundle: true,
          platform: 'browser',
          format: 'iife',
          write: false,
        });

        if (this.closed) {
          return;
        }

        const bootstrap = `
          const { parentPort } = require('node:worker_threads');
          globalThis.self = globalThis;
          globalThis.postMessage = (value) => parentPort.postMessage(value);
          const listeners = new Set();
          globalThis.addEventListener = (kind, listener) => {
            if (kind === 'message') listeners.add(listener);
          };
          globalThis.removeEventListener = (kind, listener) => listeners.delete(listener);
          ${bundle.outputFiles[0].text}
          parentPort.on('message', (data) => {
            const event = { data };
            globalThis.onmessage?.(event);
            for (const listener of listeners) listener(event);
          });
        `;

        this.worker = new NodeWorker(bootstrap, { eval: true });
        this.worker.on('message', (data) => {
          this.pending = Math.max(0, this.pending - 1);

          const deliver = () => this.emit('message', { data });

          if (deliveryInterceptor) {
            deliveryInterceptor(deliver);
          } else {
            deliver();
          }
        });
        this.worker.on('error', (error) => this.emit('error', { error, message: error.message }));
      } catch (error) {
        this.emit('error', { error, message: error.message });
      }
    }

    async postMessage(value) {
      this.pending += 1;
      await this.ready;

      if (!this.closed) {
        this.worker?.postMessage(value);
      }
    }

    addEventListener(kind, listener) {
      const listeners = this.listeners.get(kind) || new Set();

      listeners.add(listener);
      this.listeners.set(kind, listeners);
    }

    removeEventListener(kind, listener) {
      this.listeners.get(kind)?.delete(listener);
    }

    /**
     * Доставка поддерживает оба публичных браузерных способа подписки.
     * После terminate поздний ответ не должен попасть в уже размонтированный компонент.
     */
    emit(kind, event) {
      if (this.closed) {
        return;
      }

      if (kind === 'error') {
        this.pending = 0;
      }

      this[`on${kind}`]?.(event);

      for (const listener of this.listeners.get(kind) || []) {
        listener(event);
      }
    }

    /**
     * Закрытие убирает поток из обеих коллекций и прекращает дальнейшую доставку.
     * Возвращённое ожидание позволяет after-хуку дождаться освобождения потока.
     */
    terminate() {
      this.closed = true;
      instances.delete(this);
      activeWorkers.delete(this);

      return this.worker?.terminate();
    }
  }

  globalThis.Worker = BrowserWorker;
  t.after(async () => {
    await Promise.all([...instances].map((worker) => worker.terminate()));
    globalThis.Worker = previous;
  });
}

/**
 * Ожидает реальную доставку ответов потока, а не произвольное число Vue microtasks.
 * Ограниченный срок превращает зависший Worker в ошибку проверки, а не вечный прогон.
 */
export async function drainCodeReviewWorkers() {
  const deadline = Date.now() + 5_000;

  while ([...activeWorkers].some((worker) => worker.pending > 0)) {
    if (Date.now() > deadline) {
      throw new Error('Diff Worker не ответил за 5 секунд');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Задерживает только доставку настоящих ответов, не меняя их содержимое.
 * Тест сам задаёт порядок, чтобы доказать защиту от устаревшего поколения без гонки таймеров.
 */
export function holdCodeReviewWorkerResponses(t) {
  const held = [];

  deliveryInterceptor = (deliver) => held.push(deliver);
  t.after(() => {
    deliveryInterceptor = null;
  });

  return held;
}

export const activeCodeReviewWorkers = () => activeWorkers.size;
