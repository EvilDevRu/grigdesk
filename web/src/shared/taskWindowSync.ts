import type { RelayChannel } from './windowRelay.ts';
import { relayType } from './windowRelay.ts';

interface ActionEvent {
  name: string;
  after(callback: (result: unknown) => void): void;
}
interface ActionStore {
  $onAction(callback: (event: ActionEvent) => void): () => void;
}
interface SyncOptions {
  channel: RelayChannel;
  stores: {
    store: ActionStore;
    actions: readonly string[];
  }[];
  invalidate(): void;
}
/**
 * Межоконная связь сообщает только о необходимости перечитать сервер.
 * Приём никогда не публикует ответ и потому не образует петлю между двумя окнами.
 */
export function startTaskWindowSync(options: SyncOptions): () => void {
  let active = true;
  const stops = options.stores.map(({ store, actions }) => store.$onAction(({ name, after }) => {
    if (!actions.includes(name)) {
      return;
    }

    after((result) => {
      if (active && result !== false) {
        options.channel.postMessage({ version: 1, type: 'task-data-changed' });
      }
    });
  }));

  options.channel.onmessage = ({ data }) => {
    if (active && relayType(data, 2) === 'task-data-changed') {
      options.invalidate();
    }
  };

  return () => {
    active = false;
    stops.forEach((stop) => stop());
    options.channel.onmessage = null;
    options.channel.close();
  };
}

interface ReloadOptions {
  busy(): boolean;
  subscribe(callback: () => void): () => void;
  reload(): Promise<unknown>;
}
/**
 * Инвалидация не теряется, если старый GET ещё держит loading.
 * Поводы во время нового чтения склеиваются в один последующий свежий запрос.
 */
export function createQueuedReload(options: ReloadOptions) {
  let dirty = false;
  let running = false;
  let stopped = false;

  function drain(): void {
    if (stopped || running || !dirty || options.busy()) {
      return;
    }

    running = true;
    void Promise.resolve().then(() => {
      if (stopped || options.busy()) {
        return;
      }

      dirty = false;

      return options.reload();
    }).catch(() => undefined).finally(() => {
      running = false;
      drain();
    });
  }

  const unsubscribe = options.subscribe(drain);

  return {
    request(): void {
      dirty = true;
      drain();
    },
    dispose(): void {
      stopped = true;
      dirty = false;
      unsubscribe();
    },
  };
}
