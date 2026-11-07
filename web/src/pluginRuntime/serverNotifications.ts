import { watch } from 'vue';
import type { Ref } from 'vue';

import { isRecord } from '../../../shared/lib/objects.ts';
import { localizedText, messageRef } from '../../../shared/i18n/core.ts';
import type { UiText } from '../../../shared/i18n/core.ts';
import { decodePluginNotification } from '../../../shared/plugins/pluginNotifications.ts';
import type { PluginNotification } from '../../../shared/plugins/pluginNotifications.ts';
import type { PluginListItem } from '../../../shared/plugins/pluginsContracts.ts';
import type { SseEventName } from '../composables/useSse.ts';
import { api } from '../shared/apiClient.ts';
import { alertUser, dismissAlert, dismissAlertScope } from '../shared/alerts.ts';
import { isPluginModuleDescriptor } from './descriptor.ts';
import { importStudio3dSeen, readNotificationSeen } from './notificationSeen.ts';

type PluginCard = Pick<PluginListItem, 'id' | 'name' | 'enabled'> & Partial<PluginListItem>;

export interface PluginNotificationIdentity {
  owner: string;
  generation: string;
}

interface ViewingChannel {
  active: boolean;
  viewers: Map<symbol, string>;
  dismiss(topic: string): void;
}

interface PluginChannel {
  plugin: PluginCard;
  generation: string;
  viewingKey: string;
  viewing: ViewingChannel;
  topics: Map<string, string>;
}

class InvalidSnapshot extends Error {
}

const viewingChannels = new Map<string, ViewingChannel>();
const limit = 500;
const scopeOf = (id: string) => `plugin-server:${encodeURIComponent(id)}`;
const alertId = (id: string, localId: string) => `${scopeOf(id)}:${encodeURIComponent(localId)}`;
const viewingKey = (id: string, identity: PluginNotificationIdentity) =>
  JSON.stringify([identity.owner, id, identity.generation]);

/**
 * Просмотр принадлежит конкретному owner/generation и только активной панели.
 * Старый контекст не получает доступ к новому каналу после disable, reconnect или replacement.
 */
export function createPluginNotifications(pluginId: string, options: {
  signal: AbortSignal;
  panelActive: Readonly<Ref<boolean>>;
  isAlive(): boolean;
  notificationIdentity?: PluginNotificationIdentity;
}) {
  const identity = options.notificationIdentity;
  const key = identity ? viewingKey(pluginId, identity) : null;
  const token = Symbol(pluginId);
  let topic: string | null = null;
  let current: ViewingChannel | undefined;
  let disposed = false;

  /**
   * Снятие записи не очищает уведомления других тем или серверный канал.
   * Повторный показ панели восстанавливает только её собственную тему.
   */
  function sync(): void {
    current?.viewers.delete(token);
    current = key ? viewingChannels.get(key) : undefined;

    if (disposed || options.signal.aborted || !options.isAlive()
      || !options.panelActive.value || !current?.active || topic === null) {
      return;
    }

    current.viewers.set(token, topic);
    current.dismiss(topic);
  }

  const stop = watch(options.panelActive, sync, { flush: 'sync' });

  /**
   * Abort снимает регистрацию сразу, не дожидаясь последующего render/unmount.
   * Идемпотентная очистка не позволяет watcher восстановить просмотр.
   */
  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;
    stop();
    current?.viewers.delete(token);
    current = undefined;
    options.signal.removeEventListener('abort', dispose);
  }

  options.signal.addEventListener('abort', dispose, { once: true });

  if (options.signal.aborted) {
    dispose();
  }

  return Object.freeze({
    setViewing(value: string | null): void {
      if (disposed || options.signal.aborted || !options.isAlive()
        || value !== null && (typeof value !== 'string' || !value.length || value.length > 200)) {
        return;
      }

      topic = value;
      sync();
    },
  });
}

/**
 * Оболочка владеет серверными тостами независимо от наличия UI модуля.
 * Каталог, signal и монотонный requestSeq отсекают поздние ответы чужой эпохи.
 */
export function createServerNotificationBridge(options: {
  owner: string;
  clientScope: string;
  signal: AbortSignal;
  isCurrent(): boolean;
}) {
  const channels = new Map<string, PluginChannel>();
  const seen = new Map<string, string[]>();
  const failures = new Set<string>();
  let requestSeq = 0;
  let request: AbortController | null = null;
  let pending: Promise<void> | null = null;
  let signature = '';
  let disposed = false;
  const alive = () => !disposed && !options.signal.aborted && options.isCurrent();
  const storageKey = (id: string) =>
    `grigdesk-plugin-notifications-seen:${options.clientScope}:${id}`;

  seen.set('studio3d', importStudio3dSeen(options.clientScope, {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  }));

  /**
   * Каждая доставка перечитывает storage для согласования соседних окон.
   * Запрет storage оставляет тот же ограниченный memory cache без отказа обработки.
   */
  function remember(id: string, dedupKey: string): boolean {
    const stored = readNotificationSeen({
      getItem: (key) => localStorage.getItem(key),
    }, storageKey(id));

    const merged = [...new Set([...(seen.get(id) ?? []), ...stored])].slice(-limit);
    const duplicate = merged.includes(dedupKey);

    if (!duplicate) {
      merged.push(dedupKey);
    }

    const retained = merged.slice(-limit);

    seen.set(id, retained);

    try {
      localStorage.setItem(storageKey(id), JSON.stringify(retained));
    } catch {
      // Неподдерживаемое persistent storage не блокирует исход и просмотр модели.
    }

    return !duplicate;
  }

  /**
   * Явное открытие темы снимает уже показанные исходы только этой темы.
   * Seen сохраняется, поэтому snapshot/reload не возвращает снятый тост.
   */
  function dismissTopic(channel: PluginChannel, topic: string): void {
    for (const [id, value] of channel.topics) {
      if (value === topic) {
        dismissAlert(id);
        channel.topics.delete(id);
      }
    }
  }

  /**
   * Выключение или смена поколения отзывает просмотр и весь свой серверный scope.
   * UI scope plugin:<id> принадлежит отдельному lifecycle и здесь не затрагивается.
   */
  function closeChannel(id: string): void {
    const channel = channels.get(id);

    if (!channel) {
      return;
    }

    channel.viewing.active = false;
    channel.viewing.viewers.clear();

    if (viewingChannels.get(channel.viewingKey) === channel.viewing) {
      viewingChannels.delete(channel.viewingKey);
    }

    dismissAlertScope(scopeOf(id));
    failures.delete(JSON.stringify([id, channel.generation]));
    channels.delete(id);
  }

  /**
   * Общий decoder запрещает чужие цели/scope; target всегда строит оболочка.
   * Даже подавленный просмотром исход сначала становится seen.
   */
  function receive(id: string, generation: string, input: unknown): void {
    const channel = channels.get(id);
    const value = decodePluginNotification(input);

    if (!alive() || !channel || channel.generation !== generation || !value) {
      return;
    }

    if (value.action === 'clear') {
      dismissAlertScope(scopeOf(id));
      channel.topics.clear();

      return;
    }

    if (value.action === 'dismiss-topic') {
      dismissTopic(channel, value.topic);

      return;
    }

    if (value.action === 'dismiss') {
      const fullId = alertId(id, value.id);

      dismissAlert(fullId);
      channel.topics.delete(fullId);

      return;
    }

    if (!remember(id, value.dedupKey)
      || [...channel.viewing.viewers.values()].includes(value.topic)) {
      return;
    }

    const fullId = alertId(id, value.id);

    channel.topics.delete(fullId);
    channel.topics.set(fullId, value.topic);

    if (channel.topics.size > limit) {
      channel.topics.delete(channel.topics.keys().next().value!);
    }

    alertUser({
      id: fullId,
      scope: scopeOf(id),
      title: localizedText(value.title.ru, value.title.en),
      ...(value.body ? { body: localizedText(value.body.ru, value.body.en) } : {}),
      tone: value.tone,
      sticky: value.sticky,
      target: {
        kind: 'plugin',
        pluginId: id,
        params: value.params,
      },
    });
  }

  /**
   * Ошибка снимка видна один раз на поколение и не помечает исходы seen.
   * Явный retry использует ту же эпоху и общий API, без загрузки панели.
   */
  function showFailure(id: string, channel: PluginChannel, reason: UiText): void {
    const key = JSON.stringify([id, channel.generation]);

    if (!alive() || failures.has(key)) {
      return;
    }

    failures.add(key);
    alertUser({
      id: `${scopeOf(id)}:snapshot-error`,
      scope: scopeOf(id),
      title: messageRef('core.pluginNotificationsLoadFailed', { name: channel.plugin.name }),
      body: typeof reason === 'string' && reason.length > 2000 ? `${reason.slice(0, 1999)}…` : reason,
      tone: 'warning',
      sticky: true,
      actions: [{
        id: 'retry',
        label: messageRef('core.pluginNotificationsRetry'),
        run: () => refresh(),
      }],
    });
  }

  /**
   * Снимок проверяется целиком на плагин до первой публикации.
   * Неверный item не создаёт частично просмотренный набор с потерей намерений.
   */
  function acceptSnapshot(value: unknown): void {
    if (!isRecord(value) || !Array.isArray(value.plugins)) {
      throw new InvalidSnapshot();
    }

    for (const row of value.plugins) {
      if (!isRecord(row) || typeof row.pluginId !== 'string') {
        continue;
      }

      const channel = channels.get(row.pluginId);

      if (!channel || row.generation !== channel.generation) {
        continue;
      }

      if (typeof row.error === 'string') {
        showFailure(row.pluginId, channel, row.error);

        continue;
      }

      if (row.error !== null || !Array.isArray(row.items) || row.items.length > limit
        || new TextEncoder().encode(JSON.stringify(row.items)).byteLength > 1024 * 1024) {
        showFailure(row.pluginId, channel, messageRef('core.pluginNotificationsSnapshotInvalid'));

        continue;
      }

      const items = row.items.map(decodePluginNotification);

      if (items.some((item) => !item || item.action !== 'show')) {
        showFailure(row.pluginId, channel, messageRef('core.pluginNotificationsSnapshotInvalid'));

        continue;
      }

      dismissAlert(`${scopeOf(row.pluginId)}:snapshot-error`);

      for (const item of items as PluginNotification[]) {
        receive(row.pluginId, channel.generation, item);
      }
    }
  }

  /**
   * Параллельные hello/retry разделяют одну попытку актуального снимка.
   * Новое поколение отзывает её signal и seq, даже если транспорт игнорирует abort.
   */
  function refresh(): Promise<void> {
    if (!alive() || channels.size === 0) {
      return Promise.resolve();
    }

    if (pending) {
      return pending;
    }

    const controller = new AbortController();
    const seq = ++requestSeq;
    const signal = AbortSignal.any([options.signal, controller.signal]);

    request = controller;
    pending = Promise.resolve().then(async () => {
      try {
        const value = await api.get('/api/plugins/notifications', { signal });

        if (alive() && !signal.aborted && seq === requestSeq) {
          acceptSnapshot(value);
        }
      } catch (error) {
        if (alive() && !signal.aborted && seq === requestSeq) {
          for (const [id, channel] of channels) {
            const reason = error instanceof Error ? error.message : String(error);

            showFailure(id, channel, error instanceof InvalidSnapshot
              ? messageRef('core.pluginNotificationsSnapshotInvalid') : reason);
          }
        }
      } finally {
        if (seq === requestSeq) {
          pending = null;
          request = null;
        }
      }
    });

    return pending;
  }

  /**
   * Принятый каталог допускает только loaded-поколения совместимых внешних панелей.
   * Обновление настроек не перечитывает snapshot, смена generation запускает его один раз.
   */
  function acceptCatalog(catalog: readonly PluginCard[], force = false): void {
    if (!alive()) {
      return;
    }

    const eligible = catalog.filter((plugin) => plugin.enabled && !plugin.system
      && plugin.compatibility?.status !== 'incompatible' && plugin.contributes?.panels?.length
      && typeof plugin.runtimeGeneration === 'string' && plugin.runtimeGeneration.length > 0
      && isPluginModuleDescriptor(plugin.id, plugin.entrypoints?.web));
    const nextSignature = JSON.stringify(eligible.map((plugin) => [
      plugin.id,
      plugin.runtimeGeneration,
    ]).sort());
    const changed = signature !== nextSignature;

    if (changed) {
      signature = nextSignature;
      requestSeq += 1;
      request?.abort();
      request = null;
      pending = null;
    }

    for (const [id, channel] of channels) {
      if (!eligible.some((plugin) => plugin.id === id && plugin.runtimeGeneration === channel.generation)) {
        closeChannel(id);
      }
    }

    for (const plugin of eligible) {
      const previous = channels.get(plugin.id);

      if (previous) {
        previous.plugin = plugin;

        continue;
      }

      const generation = plugin.runtimeGeneration!;
      const key = viewingKey(plugin.id, { owner: options.owner, generation });
      const channel: PluginChannel = {
        plugin,
        generation,
        viewingKey: key,
        viewing: {
          active: true,
          viewers: new Map(),
          dismiss: (topic) => dismissTopic(channel, topic),
        },
        topics: new Map(),
      };

      channels.set(plugin.id, channel);
      viewingChannels.set(key, channel.viewing);
    }

    if (changed || force) {
      void refresh();
    }
  }

  /**
   * Logout/offline очищает только память и свои тосты текущей эпохи.
   * Persistent ключи владельца сохраняются для следующего входа и ручного отката.
   */
  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;
    requestSeq += 1;
    request?.abort();

    for (const id of [...channels.keys()]) {
      closeChannel(id);
    }

    seen.clear();
    failures.clear();
    options.signal.removeEventListener('abort', dispose);
  }

  options.signal.addEventListener('abort', dispose, { once: true });

  return {
    acceptCatalog,
    refresh,
    dispose,
    onEvent(name: SseEventName, value: unknown): void {
      if (name === 'plugin-event' && isRecord(value) && value.event === 'notification'
        && typeof value.pluginId === 'string' && typeof value.generation === 'string') {
        receive(value.pluginId, value.generation, value.data);
      }
    },
  };
}

export type ServerNotificationBridge = ReturnType<typeof createServerNotificationBridge>;
