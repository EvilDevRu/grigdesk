// Общая обвязка проверок доставки ходов чата: настоящий модуль чата, исполнитель, чьи
// ходы держит сам тест, и события SSE, которые тест раздаёт «окнам». Реальных запусков
// ИИ нет: исполнитель отвечает только по команде теста.
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));

export const Fastify = requireFromServer('fastify');
export const TEST_MODEL_REF = Object.freeze({ provider: 'test-provider', model: 'test-model' });

/**
 * Исполнитель под управлением теста. Каждый запуск висит, пока тест не вызовет
 * `release`/`fail`, а «стоп» обрывает его так же, как настоящий CLI: ошибкой stopped.
 * Спросы (разрешение и вопрос) идут тем же мостом onPermission, что у Kimi.
 */
export function controlledExecutor({ id = 'test-provider' } = {}) {
  const runs = [];
  const waiters = new Set();

  // Разбудить тех, кто ждёт нужного числа запусков: waitForRuns отдаёт первые count
  // запусков в порядке старта, как их увидел исполнитель.
  function wake() {
    for (const waiter of [...waiters]) {
      if (runs.length >= waiter.count) {
        waiters.delete(waiter);
        waiter.resolve(runs.slice(0, waiter.count));
      }
    }
  }

  const executor = {
    id,
    // Запуск хода: одна строка ленты сразу, ответ — по release/fail теста, abort —
    // ошибка stopped с той же лентой, как у настоящего CLI после «стопа».
    async run(options) {
      const run = {
        chatKey: options.chatKey,
        message: String(options.message || ''),
        options,
      };
      const steps = [{
        k: 'text',
        text: 'работаю',
        at: Date.now(),
      }];
      const done = new Promise((resolve, reject) => {
        run.release = (reply = `Ответ ${runs.indexOf(run) + 1}`, extra = {}) => {
          resolve({
            reply,
            sessionId: `sess-${options.chatKey}`,
            steps,
            cost: 0,
            ...extra,
          });
        };
        run.fail = (message = 'сбой исполнителя') => {
          reject(new Error(message));
        };
        options.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('Ход остановлен.'), { stopped: true, steps }));
        }, { once: true });
      });

      run.ask = (presentation) => options.onPermission(presentation);
      runs.push(run);

      for (const step of steps) {
        options.onStep?.(step);
      }

      wake();

      return done;
    },
  };

  /**
   * Дождаться, пока исполнитель получит не меньше `count` запусков. Не дождались за
   * timeoutMs — ошибка с числом полученных запусков, а не вечное ожидание теста.
   */
  function waitForRuns(count, timeoutMs = 5000) {
    if (runs.length >= count) {
      return Promise.resolve(runs.slice(0, count));
    }

    return new Promise((resolve, reject) => {
      const waiter = { count, resolve };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`исполнитель получил ${runs.length} запусков из ${count}`));
      }, timeoutMs);

      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiters.add(waiter);
    });
  }

  return {
    executor,
    runs,
    waitForRuns,
  };
}

/**
 * Модуль чата во временном каталоге. `sse` — куда уходят события: по умолчанию они
 * только копятся в `events`, тест может раздавать их окнам через `onEvent`.
 */
export async function chatAppFixture(t, {
  executor,
  prefs: givenPrefs = null,
  root: givenRoot = '',
  onEvent = null,
  withSsePlugin = false,
  backgroundStopGraceMs,
  shutdownGraceMs = 30,
  shutdownInterruptMs = 150,
  extraRoutes = null,
  taskEnv = null,
  modelsRegistry = async () => ({ 'test-provider': [{ id: 'test-model', efforts: [] }] }),
  // Паузы автопродолжения для интеграционных проверок: короткие значения вместо
  // боевых минут, чтобы тест ждал событие, а не реальное время.
  autoContinueDelaysMs = null,
} = {}) {
  const root = givenRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-turns-'));

  // Как у рабочего сервера: закрытие рвёт и висящие ответы, иначе красный прогон
  // (POST держится до конца хода) повис бы на уборке, а не упал на проверке.
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const events = [];
  const drainSteps = [];

  if (withSsePlugin) {
    const { default: ssePlugin } = await import('../../../server/src/plugins/sse.ts');

    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await app.register(ssePlugin, { stateDir: path.join(root, 'state') });
    app.sse.subscribe((event, data) => {
      events.push({ event, data });
      onEvent?.(event, data);
    });
  } else {
    app.decorate('sse', {
      broadcast(event, data) {
        events.push({ event, data });
        onEvent?.(event, data);
      },
    });
  }

  app.decorate('shutdown', {
    get active() {
      return false;
    },
    register(name, run) {
      drainSteps.push({ name, run });
    },
    async begin() {},
    arm() {},
  });

  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    agentsDir: path.join(root, 'agents'),
    artifactsDir: path.join(root, 'artifacts'),
    port: 18140,
  };

  await app.register(chatModule, {
    config,
    factoryState: {
      async readEnv() {
        return taskEnv ?? {};
      },
    },
    prefs: {
      read() {
        return {
          providerSettings: {},
          chatAutoCompactWindow: 0,
          speech: {},
          ...(givenPrefs || {}),
        };
      },
    },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry,
    executorResolver: async () => executor,
    ...(autoContinueDelaysMs ? { autoContinueDelaysMs } : {}),
    backgroundStopGraceMs,
    shutdownGraceMs,
    shutdownInterruptMs,
  });

  if (extraRoutes) {
    await extraRoutes(app);
  }

  // Уборка одним шагом и по порядку: сначала сервер, потом каталог. Окно теста ещё может
  // дописывать историю в момент удаления, поэтому rm повторяется при ENOTEMPTY.
  t.after(async () => {
    await app.close();

    if (!givenRoot) {
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
      });
    }
  });

  /**
   * Слив остановки: зарегистрированные модулем шаги вызывает сам тест, по порядку, —
   * так проверяется и прерывание идущих ходов, и итог ходов из очереди.
   */
  async function drain() {
    for (const step of drainSteps) {
      await step.run();
    }
  }

  return {
    app,
    root,
    config,
    events,
    drain,
  };
}

/**
 * Сохранить чат с моделью теста так же, как это делает окно перед отправкой: ход
 * принимается только у чата, который уже лежит в истории с modelRef.
 */
export async function saveChat(app, id, extra = {}) {
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id,
        title: extra.title || `Чат ${id}`,
        modelRef: TEST_MODEL_REF,
        model: TEST_MODEL_REF.model,
        messages: extra.messages || [],
        createdAt: Date.UTC(2026, 8, 1),
        updatedAt: Date.UTC(2026, 8, 1),
        revision: 0,
      },
    },
  });

  if (saved.statusCode !== 200) {
    throw new Error(`чат ${id} не сохранился: ${saved.statusCode} ${saved.body}`);
  }

  return saved.json();
}

/**
 * Тело запуска хода, как его шлёт окно по протоколу приёма. sentAt фиксирован, чтобы
 * итог в pending можно было сверять с ожидаемым временем реплики.
 */
export function turnBody(chatKey, turnId, message = 'привет', extra = {}) {
  return {
    chatKey,
    turnId,
    modelRef: TEST_MODEL_REF,
    model: TEST_MODEL_REF.model,
    message,
    sentAt: Date.UTC(2026, 8, 27, 10),
    ...extra,
  };
}

/**
 * Дождаться условия, опрашивая его короткими паузами: тест не спит дольше нужного, а
 * по истечении срока падает с названием того, чего не дождался.
 */
export async function waitFor(check, { timeoutMs = 5000, stepMs = 5, what = 'условие' } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await check();

    if (value) {
      return value;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, stepMs);
    });
  }

  throw new Error(`не дождались: ${what}`);
}
