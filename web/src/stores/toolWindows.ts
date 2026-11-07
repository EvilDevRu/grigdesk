import { toolWindowText } from '../shared/tools/toolWindowMessages.ts';

import { markRaw, nextTick } from 'vue';
import type { Router } from 'vue-router';
import type { useDockStore } from './dock.ts';
import type { useUiContextStore } from './uiContext.ts';
import type { ToolIntent } from '../shared/tools/launcher.ts';
import type { ToolWindowState } from '../shared/tools/toolWindowState.ts';
import { parseToolWindowMessage } from '../shared/tools/toolWindowRelay.ts';

import { recordOrNull } from '../../../shared/lib/objects.ts';

export interface ToolChannel {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}

type Dock = ReturnType<typeof useDockStore>;
type Context = ReturnType<typeof useUiContextStore>;
interface NativeTool {
  open(id: string): Promise<{
    opened?: boolean;
    instance?: string;
    status?: string;
  }>;
  status(): Promise<{ id: string; instance: string }[]>;
  focus(id: string, instance: string): Promise<boolean>;
  close(id: string, instance: string): Promise<boolean>;
}
interface CoordinatorOptions {
  origin: string;
  scope: string;
  epoch: string;
  dock: Dock;
  context: Context;
  channel: ToolChannel;
  native: NativeTool;
  panels: {
    exportState(id: string): Promise<ToolWindowState>;
    unmount(id: string): Promise<void>;
    mount(id: string, state: ToolWindowState): Promise<void>;
  };
  router: Pick<Router, 'push' | 'beforeEach'>;
  canDock(): boolean;
  chat?: { newSession(options: Record<string, unknown>): unknown };
  allowed?(): boolean;
}
interface Entry {
  instance: string;
  state: ToolWindowState;
  ready: boolean;
  initialized: boolean;
  queue: { seq: number; intent: ToolIntent }[];
  sent: number;
  opening?: Promise<void>;
  returns: Map<number, Record<string, unknown>>;
  actions: Set<number>;
}

const coordinatorKey = Symbol.for('grigdesk.toolWindowCoordinator');

type AttachedDock = Dock & { [coordinatorKey]?: ToolWindowCoordinator };
export type ToolWindowCoordinator = ReturnType<typeof createToolWindowCoordinator>;

/**
 * Возвращает координатор именно этого dock без глобального состояния пользователя.
 * Несколько документов и тестовых Pinia не смешивают своих владельцев.
 */
export function getToolWindowCoordinator(dock: Dock): ToolWindowCoordinator | undefined {
  return (dock as AttachedDock)[coordinatorKey];
}

/**
 * Единственный координатор документа передаёт владение до открытия native окна.
 * Отправленная команда не возвращается в локальную очередь при потерянном подтверждении.
 */
export function createToolWindowCoordinator(options: CoordinatorOptions) {
  const { dock, channel, native, panels } = options;
  const entries = new Map<string, Entry>();
  const contexts: Record<string, Record<string, unknown>> = {};
  const owner = options.context.register('toolWindow', { active: false, layer: 'dock' });
  const early = new Map<string, string>();
  let disposed = false;
  let sequence = 0;

  function publish() {
    owner.update({
      layer: 'dock',
      active: Object.keys(contexts).length > 0,
      details: { ...contexts },
    });
  }

  function send(id: string, type: string, fields: Record<string, unknown> = {}) {
    const entry = entries.get(id);

    if (entry && !disposed) {
      channel.postMessage({
        version: 1,
        type,
        target: { kind: 'tool', id },
        instance: entry.instance,
        scope: options.scope,
        coordinatorEpoch: options.epoch,
        seq: 0,
        ...fields,
      });
    }
  }

/**
 * Отправляет только голову очереди после init и подтверждения предыдущей команды.
 * Потерянный consumed оставляет команду в полёте без автоматического повтора.
 */
  function pump(id: string) {
    const entry = entries.get(id);

    if (!entry?.initialized || entry.sent || !entry.queue.length || options.allowed?.() === false) {
      return;
    }

    const command = entry.queue[0]!;

    entry.sent = command.seq;
    send(id, 'command', command);
  }

  function init(id: string) {
    const entry = entries.get(id);

    if (entry?.ready && entry.instance && !entry.initialized) {
      send(id, 'init', { state: entry.state });
    }
  }

  /**
   * Возврат подтверждается после восстановления единственного локального владельца.
   * Повтор того же номера получает сохранённый ответ без повторного mount.
   */
  async function returning(id: string, entry: Entry, seq: number, state: ToolWindowState) {
    const previous = entry.returns.get(seq);

    if (previous) {
      send(id, 'return-ack', previous);

      return;
    }

    try {
      if (!options.canDock()) {
        const reply = {
          seq,
          accepted: false,
          error: toolWindowText('toolReturnNarrow'),
        };

        entry.returns.set(seq, reply);
        send(id, 'return-ack', reply);

        return;
      }

      await panels.mount(id, state);
      delete dock.windowOwners[id];
      dock.open(id);
      await nextTick();
      delete contexts[id];
      publish();

      const reply = { seq, accepted: true };

      entry.returns.set(seq, reply);
      send(id, 'return-ack', reply);
    } catch {
      dock.windowOwners[id] = true;
      await panels.unmount(id);
      send(id, 'return-ack', {
        seq,
        accepted: false,
        error: toolWindowText('toolReturnFailed'),
      });
    }
  }

  /**
   * Сообщение адресуется текущему scope, поколению координатора и native instance.
   * Контекст очищается по положительному списку отдельно от снимка панели.
   */
  async function receive(value: unknown) {
    const message = parseToolWindowMessage(value);
    const target = recordOrNull(message?.target);

    if (disposed || !message || message.version !== 1 || message.scope !== options.scope
      || target?.kind !== 'tool' || typeof target.id !== 'string'
      || (message.coordinatorEpoch !== options.epoch && message.type !== 'ready')) {
      return;
    }

    const id = target.id;
    const entry = entries.get(id);

    if (!entry) {
      return;
    }

    if (message.type === 'ready' && typeof message.instance === 'string') {
      early.set(id, message.instance);
    }

    if (message.instance !== entry.instance) {
      return;
    }

    const seq = Number(message.seq);

    if (!Number.isSafeInteger(seq) || seq < 0) {
      return;
    }

    if (message.type === 'ready') {
      entry.ready = true;

      // Новый документ ещё не знает эпоху main; прежний init-ack его не подтверждает.
      // Готовое окно с той же эпохой не получает повторный полный снимок каждую секунду.
      if (message.coordinatorEpoch !== options.epoch) {
        entry.initialized = false;
      }

      init(id);
    } else if (message.type === 'init-ack') {
      entry.initialized = true;
      pump(id);
    } else if (message.type === 'consumed' && entry.sent === seq) {
      entry.queue.shift();
      entry.sent = 0;
      pump(id);
    } else if (message.type === 'return' && recordOrNull(message.state)) {
      await returning(id, entry, seq, message.state as ToolWindowState);
    } else if (message.type === 'context') {
      const value = recordOrNull(message.context) ?? {};
      const safe: Record<string, unknown> = { id, presentation: 'window' };

      if (id === 'code') {
        for (const key of ['project', 'repository', 'context', 'tab', 'file']) {
          if (typeof value[key] === 'string') {
            safe[key] = String(value[key]).slice(0, 512);
          }
        }

        if (Number.isSafeInteger(value.line) && Number(value.line) > 0) {
          safe.line = value.line;
        }
      }

      contexts[id] = safe;
      publish();
    } else if (message.type === 'main-action' && id === 'code') {
      const action = recordOrNull(message.action);

      if (action?.type !== 'code-chat' || typeof action.draft !== 'string'
        || action.draft.length > 2097152 || typeof action.title !== 'string'
        || Object.keys(action).some((key) => !['type', 'title', 'draft', 'taskId', 'workdir']
          .includes(key))) {
        return;
      }

      if (!entry.actions.has(seq) && options.allowed?.() !== false) {
        entry.actions.add(seq);

        const { type: _type, ...draft } = action;

        options.chat?.newSession(draft);
        await options.router.push('/chats');
      }

      send(id, 'main-action-ack', { seq });
    }
  }

  channel.onmessage = (event) => {
    void receive(event.data);
  };

  /**
   * Подтверждённый отказ возвращает исходный снимок, неизвестный исход требует status.
   * Второй detach использует текущую передачу и никогда не повторяет native POST.
   */
  async function detach(id: string): Promise<void> {
    const current = entries.get(id);

    if (current) {
      await activateIfDetached(id);

      return current.opening;
    }

    const entry: Entry = {
      instance: '',
      state: {},
      ready: false,
      initialized: false,
      queue: [],
      sent: 0,
      returns: new Map(),
      actions: new Set(),
    };

    entries.set(id, entry);
    entry.opening = (async () => {
      try {
        entry.state = await panels.exportState(id);

        const local = recordOrNull(recordOrNull(options.context.capture({ path: '/' })
          .promptContext.details)?.tool);

        contexts[id] = { id, presentation: 'window' };

        if (id === 'code' && local?.id === id) {
          for (const key of ['project', 'repository', 'context', 'tab', 'file', 'line']) {
            if (local[key] !== undefined) {
              contexts[id]![key] = local[key];
            }
          }
        }

        publish();
        dock.windowOwners[id] = true;
        await panels.unmount(id);
        dock.setMounted(id, false);
        dock.close();

        let result = await native.open(id);

        if (result.status === 'unknown') {
          const known = (await native.status()).find((item) => item.id === id);

          result = known ? { opened: true, instance: known.instance } : { opened: false };
        }

        if (disposed) {
          return;
        }

        if (result.opened === false) {
          entries.delete(id);
          delete dock.windowOwners[id];
          await panels.mount(id, entry.state);
          dock.open(id);

          return;
        }

        if (result.instance) {
          entry.instance = result.instance;
          entry.ready = early.get(id) === result.instance;
          init(id);
        }
      } catch (reason) {
        if (!dock.windowOwners[id]) {
          entries.delete(id);
          dock.setRuntime(id, { transferError: String(reason) });
        }
        // После снятия панели неизвестный исход сохраняет передачу без локального дубля.
      }
    })();

    return entry.opening;
  }

/**
 * Сверяет native status без повторения команды создания окна.
 * При загрузке main может принять уже живые документы, сохраняя одного владельца.
 */
  async function reconcile(adopt = false) {
    if (disposed || options.allowed?.() === false) {
      return;
    }

    try {
      const known = await native.status();

      if (disposed) {
        return;
      }

      if (adopt) {
        for (const live of known) {
          if (!entries.has(live.id)) {
            entries.set(live.id, {
              instance: live.instance,
              state: {},
              ready: false,
              initialized: false,
              queue: [],
              sent: 0,
              returns: new Map(),
              actions: new Set(),
            });
            dock.windowOwners[live.id] = true;
            await panels.unmount(live.id);
          }
        }
      }

      for (const [id, entry] of entries) {
        if (!entry.instance) {
          const live = known.find((item) => item.id === id);

          if (live) {
            entry.instance = live.instance;
            entry.ready = early.get(id) === live.instance;
            init(id);
          }
        } else if (!known.some((item) => item.id === id && item.instance === entry.instance)) {
          closed({ id, instance: entry.instance });
        }
      }
    } catch {
      // Недоступный status не доказывает отсутствие окна и не разрешает второй mount.
    }
  }

/**
 * Выбирает оконного адресата до любого локального enqueue или перехода маршрута.
 * Фокусировка использует только существующую instance и не создаёт нового окна.
 */
  async function activateIfDetached(id: string, intent?: ToolIntent | null): Promise<boolean> {
    const entry = entries.get(id);

    if (!entry || entry.returns.size && !dock.windowOwners[id]) {
      return false;
    }

    if (intent) {
      entry.queue.push({ seq: ++sequence, intent });
      pump(id);
    }

    if (entry.instance) {
      try {
        if (!await native.focus(id, entry.instance)) {
          await reconcile();

          return entries.has(id);
        }
      } catch {
        // Неизвестный исход focus не создаёт окно или локальную панель.
      }
    }

    return true;
  }

  function closed(value: { id: string; instance: string }) {
    const entry = entries.get(value.id);

    if (entry?.instance === value.instance) {
      entries.delete(value.id);
      delete dock.windowOwners[value.id];
      delete contexts[value.id];
      publish();
    }
  }

  const removeGuard = options.router.beforeEach?.(async (to) => {
    const id = to.meta.tool === 'ext' ? String(to.params.id ?? to.path.split('/').at(-1))
      : typeof to.meta.tool === 'string' ? to.meta.tool : '';
    let intent: ToolIntent | null = null;

    if (id === 'code' && to.query.path) {
      const { project, repo, root, path, line } = to.query;

      intent = {
        type: 'open-file',
        project,
        repo,
        root,
        path,
        line: Number(line) || 0,
      };
    }

    return await activateIfDetached(id, intent) ? false : undefined;
  });

/**
 * Освобождает канал, guard и собственный контекст при смене области документа.
 * Сохранённые на диске настройки содержат только геометрию, без detached-списка.
 */
  function dispose() {
    disposed = true;
    removeGuard?.();
    channel.close();
    owner.dispose();
    entries.clear();
    dock.windowOwners = {};

    if ((dock as AttachedDock)[coordinatorKey] === coordinator) {
      delete (dock as AttachedDock)[coordinatorKey];
    }
  }

  const coordinator = markRaw({
    detach,
    activateIfDetached,
    closed,
    reconcile,
    dispose,
  });

  (dock as AttachedDock)[coordinatorKey] = coordinator;

  return coordinator;
}
