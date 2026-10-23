import { watch } from 'vue';
import { recordOrNull } from '../../../../shared/lib/objects.ts';
import { parseToolWindowState } from './toolWindowState.ts';
import type { ToolWindowState } from './toolWindowState.ts';
import type { ToolChannel } from '../../stores/toolWindows.ts';
import type { ToolIntent } from './launcher.ts';
import type { useTaskShelfStore } from '../../stores/taskShelf.ts';

const MESSAGE_FIELDS: Record<string, string[]> = {
  ready: [],
  init: ['state'],
  'init-ack': [],
  command: ['intent'],
  consumed: [],
  state: ['state'],
  context: ['context'],
  return: ['state'],
  'return-ack': ['accepted', 'error'],
  'main-action': ['action'],
  'main-action-ack': [],
};

/**
 * Верхняя форма сообщения закрыта: лишние поля не расширяют полномочия канала.
 * Снимки и контекст имеют разные проверки, чтобы секреты выбора не попадали в prompt.
 */
export function parseToolWindowMessage(value: unknown): Record<string, unknown> | null {
  const item = recordOrNull(value);
  const target = recordOrNull(item?.target);
  const extra = typeof item?.type === 'string' ? MESSAGE_FIELDS[item.type] : undefined;
  const base = ['version', 'type', 'target', 'instance', 'scope', 'coordinatorEpoch', 'seq'];

  if (!item || !target || target.kind !== 'tool' || typeof target.id !== 'string'
    || Object.keys(target).length !== 2 || !extra || item.version !== 1
    || typeof item.instance !== 'string' || !item.instance || item.instance.length > 128
    || typeof item.scope !== 'string' || item.scope.length > 512
    || typeof item.coordinatorEpoch !== 'string' || item.coordinatorEpoch.length > 128
    || !Number.isSafeInteger(item.seq) || Number(item.seq) < 0
    || Object.keys(item).some((key) => !base.includes(key) && !extra.includes(key))) {
    return null;
  }

  if (['init', 'return', 'state'].includes(String(item.type))
    && !parseToolWindowState(target.id, item.state)) {
    return null;
  }

  return item;
}

interface ReceiverOptions {
  origin: string;
  scope: string;
  target: { kind: 'tool'; id: string };
  instance: string;
  channel: ToolChannel;
  importState(state: ToolWindowState): Promise<void>;
  enqueue(intent: ToolIntent, seq: number, epoch: string): void;
  returned?(accepted: boolean, error?: string): void;
}

/**
 * Получатель сохраняет номер до enqueue: повтор доставки не создаёт второй intent.
 * Подтверждение consumed отдаёт только сама панель после завершения команды.
 */
export function createToolWindowReceiver(options: ReceiverOptions) {
  const { channel } = options;
  const scope = options.scope;
  let epoch = '';
  let initialized = false;
  let importing = false;
  let disposed = false;
  let highWater = 0;
  let consumed = 0;
  let actionSeq = 0;
  const retiredEpochs = new Set<string>();
  let lastContext: unknown = null;
  let pendingReturn: { seq: number; state: ToolWindowState } | null = null;

  function send(type: string, fields: Record<string, unknown> = {}) {
    if (!disposed) {
      channel.postMessage({
        version: 1,
        type,
        target: options.target,
        instance: options.instance,
        scope,
        coordinatorEpoch: epoch,
        seq: 0,
        ...fields,
      });
    }
  }

  /**
   * Снимок импортируется один раз, а номера команд принадлежат эпохе main.
   * Повторный init подтверждается без импорта; прежняя эпоха не может вернуться.
   */
  async function receive(value: unknown) {
    const message = parseToolWindowMessage(value);
    const target = recordOrNull(message?.target);

    if (disposed || !message || message.version !== 1 || message.scope !== scope
      || message.instance !== options.instance || target?.kind !== 'tool'
      || target.id !== options.target.id || typeof message.coordinatorEpoch !== 'string') {
      return;
    }

    if (message.type === 'init') {
      if (retiredEpochs.has(message.coordinatorEpoch)) {
        return;
      }

      if (initialized) {
        if (epoch !== message.coordinatorEpoch) {
          retiredEpochs.add(epoch);
          highWater = 0;
          consumed = 0;
        }

        epoch = message.coordinatorEpoch;
        send('init-ack');
        send('context', { context: lastContext });

        return;
      }

      const state = parseToolWindowState(options.target.id, message.state);

      if (!state || importing) {
        return;
      }

      importing = true;
      epoch = message.coordinatorEpoch;

      try {
        await options.importState(state);
        initialized = true;
        send('init-ack');
      } catch {
        // Ошибка импорта сохраняет окно и его диагностическую шапку без второго владельца.
      } finally {
        importing = false;
      }

      return;
    }

    if (!initialized || message.coordinatorEpoch !== epoch) {
      return;
    }

    const seq = Number(message.seq);

    if (!Number.isSafeInteger(seq) || seq < 0) {
      return;
    }

    if (message.type === 'command') {
      if (seq <= highWater) {
        if (seq <= consumed) {
          send('consumed', { seq });
        }

        return;
      }

      const intent = recordOrNull(message.intent);

      if (typeof intent?.type !== 'string') {
        return;
      }

      highWater = seq;
      options.enqueue(intent as ToolIntent, seq, epoch);
    } else if (message.type === 'return-ack' && pendingReturn?.seq === seq) {
      pendingReturn = null;
      options.returned?.(message.accepted === true,
        typeof message.error === 'string' ? message.error : undefined);
    }
  }

  channel.onmessage = (event) => {
    void receive(event.data);
  };
  send('ready');

  return {
    consume(seq: number, commandEpoch = epoch) {
      if (commandEpoch === epoch && seq === highWater && seq > consumed) {
        consumed = seq;
        send('consumed', { seq });
      }
    },
    ready() {
      send('ready');

      if (pendingReturn) {
        send('return', pendingReturn);
      }
    },
    context(context: unknown) {
      lastContext = context;
      send('context', { context });
    },
    returnState(state: ToolWindowState) {
      pendingReturn = { state, seq: ++actionSeq };
      send('return', pendingReturn);
    },
    mainAction(action: Record<string, unknown>) {
      send('main-action', { action, seq: ++actionSeq });
    },
    dispose() {
      disposed = true;
      channel.close();
    },
  };
}

interface ShelfRelayOptions {
  role: 'source' | 'mirror';
  channel: ToolChannel;
  store: ReturnType<typeof useTaskShelfStore>;
  instance: string;
}

/**
 * Главное окно передаёт готовые строки Полки без запуска её producers в зеркале.
 * Отдельный номер проекции отсеивает поздние снимки при неизменной серверной ревизии.
 */
export function startToolShelfRelay({ role, channel, store, instance }: ShelfRelayOptions) {
  let revision = 0;
  let accepted = 0;
  let disposed = false;
  const stops: (() => void)[] = [];

  function snapshot() {
    return JSON.parse(JSON.stringify({
      scope: store.scope,
      revision: store.revision,
      entries: store.entries,
      rows: store.rows,
      sourceIssues: store.sourceIssues,
      loaded: store.loaded,
      error: store.error,
    }));
  }

  function publish() {
    if (!disposed) {
      channel.postMessage({
        version: 1,
        type: 'shelf-snapshot',
        instance,
        projection: ++revision,
        snapshot: snapshot(),
      });
    }
  }

  channel.onmessage = (event) => {
    const message = recordOrNull(event.data);

    if (disposed || message?.version !== 1 || message.instance !== instance) {
      return;
    }

    if (role === 'source') {
      if (message.type === 'shelf-ready') {
        publish();
      } else if (message.type === 'shelf-action' && typeof message.taskId === 'string') {
        const operation = message.action === 'remove' ? store.remove(message.taskId)
          : message.action === 'acknowledge' ? store.acknowledge(message.taskId) : false;

        void Promise.resolve(operation).then(publish);
      }
    } else if (message.type === 'shelf-snapshot' && Number.isSafeInteger(message.projection)
      && Number(message.projection) > accepted) {
      const value = recordOrNull(message.snapshot);

      if (value && Array.isArray(value.rows) && Array.isArray(value.entries)
        && Array.isArray(value.sourceIssues)) {
        accepted = Number(message.projection);
        store.applyViewSnapshot(value);
      }
    }
  };

  if (role === 'source') {
    stops.push(watch(() => JSON.stringify(snapshot()), publish));
  } else {
    store.setViewMirror(true);
    store.setViewAction((action, taskId) => {
      channel.postMessage({
        version: 1,
        type: 'shelf-action',
        instance,
        action,
        taskId,
      });

      return true;
    });
    channel.postMessage({
      version: 1,
      type: 'shelf-ready',
      instance,
    });
  }

  return () => {
    disposed = true;
    stops.forEach((stop) => stop());
    store.setViewAction(null);
    channel.close();
  };
}
