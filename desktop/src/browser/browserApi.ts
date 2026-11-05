import { randomUUID } from 'node:crypto';

import { browserUrl, normalizeBrowserPreferences } from '../../../shared/browser/browserContract.ts';
import { parseBrowserAction } from '../../../shared/browser/browserActions.ts';
import { isPlainRecord } from '../../../shared/lib/objects.ts';
import { browserTabOrigin, createBrowserTabs } from './browserTabs.ts';
import { createBrowserDriver } from './browserDriver.ts';
import { createBrowserProtocol } from './browserProtocol.ts';

import type { BrowserPreferences } from '../../../shared/browser/browserContract.ts';
import type { BrowserRect } from './browserTabs.ts';
import type { BrowserViewEvents, NativeBrowserView } from './browserView.ts';

interface NativeCommand {
  requestId: string;
  hostId: string;
  hostEpoch: number;
  owner: string;
  grantEpoch: number;
  deadline: number;
  action: string;
  tabId?: string;
  pageEpoch?: number;
  [key: string]: unknown;
}

interface Host {
  hostId: string;
  hostEpoch: number;
  leaseUntil: number;
}

/**
 * Preferences не меняют runtime до подтверждённого диска.
 * Тот же commit использует общую очередь updateSettings, без optimistic mutation.
 */
export async function saveBrowserPreferences(port: {
  commit(value: BrowserPreferences): Promise<void>;
  changed(): void;
}, value: unknown) {
  const next = normalizeBrowserPreferences(value);

  await port.commit(next);
  port.changed();

  return next;
}

/**
 * Координаты события мыши приводятся от CSS-пикселей страницы к DIP-пикселям ввода.
 * Zoom вкладки приходит процентами (100 = без масштабирования); чужие поля метода
 * копируются без изменений, а некорректное значение оставляет params как есть.
 */
function scaleMouseEvent(percent: number, params: unknown): unknown {
  if (!isPlainRecord(params) || !Number.isFinite(percent) || percent <= 0 || percent === 100
    || !Number.isFinite(Number(params.x)) || !Number.isFinite(Number(params.y))) {
    return params;
  }

  return {
    ...params,
    x: Number(params.x) * (percent / 100),
    y: Number(params.y) * (percent / 100)
  };
}

/**
 * UI и host используют один native runtime, но имеют разные закрытые operations.
 * Agent input всегда проходит parser, host/grant/epoch checks и последовательность tab.
 */
export function createBrowserApi(options: {
  preferences(): BrowserPreferences;
  commit(value: BrowserPreferences): Promise<void>;
  apps(): Promise<{ id: string; name: string }[]>;
  chooseApp(): Promise<{ id: string; name: string } | null>;
  external(id: string, url: string): Promise<unknown>;
  view(input: {
    id: string;
    scope: string;
    events: BrowserViewEvents
  }): NativeBrowserView;
  bounds(): {
    width: number;
    height: number;
    zoom: number
  };
  changed?(snapshot: unknown): void;
  intent?(value: 'address' | 'new' | 'close' | 'back' | 'forward'): void;
  now?: () => number;
  id?: () => string;
}) {
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const views = new Map<string, {
    view: NativeBrowserView;
    send: NativeBrowserView['send'];
    protocol: ReturnType<typeof createBrowserProtocol>;
    driver: ReturnType<typeof createBrowserDriver>;
    command: NativeCommand | null;
    dispatched: boolean;
  }>();
  const queues = new Map<string, Promise<unknown>>();
  const completed = new Map<string, Promise<unknown>>();
  const validations = new WeakMap<NativeCommand, () => boolean>();
  const subscribers = new Set<() => void>();
  const retiredViewports = new Set<string>();
  let revision = 0;
  let host: Host | null = null;
  let viewport: { instance: string; revision: number } | null = null;
  let disposed = false;
  let preferenceQueue = Promise.resolve();
  let leaseTimer: ReturnType<typeof setTimeout> | null = null;

  const snapshot = () => ({
    revision,
    tabs: tabs.list().map((tab) => ({ ...tab, ...views.get(tab.id)!.view.state() })),
    active: tabs.activeId(),
    preferences: { ...options.preferences() },
    grants: tabs.list().filter((tab) => tab.grantOrigin !== null
      && (tab.grantee ?? tab.owner) !== null).map((tab) => ({
      tabId: tab.id,
        grantEpoch: tab.grantEpoch,
        pageEpoch: tab.pageEpoch,
      paused: tab.paused || tab.navigating,
    })),
  });
  const changed = () => {
    revision += 1;
    options.changed?.(snapshot());

    for (const subscriber of [...subscribers]) {
      subscriber();
    }
  };
  const globalAllowed = (command: NativeCommand) => Boolean(!disposed && options.preferences().agents
    && validations.get(command)?.()
    && host && host.hostId === command.hostId && host.hostEpoch === command.hostEpoch
    && host.leaseUntil > now() && command.deadline > now());
  const allowed = (command: NativeCommand, tabId: string) => globalAllowed(command)
    && tabs.allowed(tabId, command.owner, command.grantEpoch);

  /**
   * Очередь сериализует действие целиком, а revoke/pause остаются синхронными снаружи.
   * Отказ предыдущей команды не блокирует проверку прав следующей.
   */
  function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);

    queues.set(key, pending);
    void pending.finally(() => {
      if (queues.get(key) === pending) {
        queues.delete(key);
      }
    }).catch(() => undefined);

    return pending;
  }

  /**
   * Зависший CDP или capture не удерживает tab queue бесконечно.
   * Неизвестный исход мутации отзывает grant. Захват только читает страницу:
   * его отказ не лишает агента доступа и завершается раньше сторожа транспорта.
   */
  function bounded<T>(pending: Promise<T>, value: NativeCommand, tabId: string,
    timeout?: () => void, limit?: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          if (value.action !== 'screenshot') {
            tabs.revoke(tabId);
          }

          timeout?.();
        } catch {
          // Закрытый tab уже не имеет действующего grant.
        }

        reject(new Error(value.action === 'screenshot' ? 'browser_capture_failed' : 'outcome_unknown'));
      }, Math.max(1, Math.min(value.deadline - now(), limit ?? Infinity)));

      pending.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  /**
   * Popup наследует session, но другой origin никогда не получает implicit grant.
   * Поздний popup после pause/navigation не сохраняет старое разрешение родителя.
   */
  async function popup(parentId: string, url: string): Promise<void> {
    const parent = tabs.get(parentId);
    const recipient = tabs.effectiveOwner(parentId);
    const epoch = parent.grantEpoch;
    const sameOrigin = browserTabOrigin(parent.url) === browserTabOrigin(url);
    const child = await tabs.open(browserUrl(url), parent.owner, false, {
      scope: tabs.scope(parentId), authorized: false,
    });

    if (sameOrigin && recipient && tabs.allowed(parentId, recipient, epoch)) {
      tabs.grant(child.id, recipient);
    } else {
      tabs.revoke(child.id);
    }
  }

  const tabs = createBrowserTabs({
    id,
    now,
    changed,
    /**
     * Одна вкладка связывает native view, protocol и input driver.
     * Доступ повторно проверяется в общем send перед каждым CDP-эффектом.
     */
    create(tabId, scope) {
      const events: BrowserViewEvents = {
        start: () => {
          if (views.has(tabId)) {
            tabs.beginNavigation(tabId);
            views.get(tabId)!.protocol.reset();
          }
        },
        navigated: (url) => {
          if (views.has(tabId)) {
            tabs.navigated(tabId, url);
          }
        },
        metadata: (value) => {
          if (views.has(tabId)) {
            tabs.metadata(tabId, value);
          }
        },
        lost: () => {
          if (views.has(tabId)) {
            tabs.revoke(tabId);
            views.get(tabId)!.protocol.reset();
          }
        },
        popup: (url) => {
          void popup(tabId, url).catch(() => undefined);
        },
        intent: (value) => options.intent?.(value),
      };
      const view = options.view({
        id: tabId,
        scope,
        events
      });
      /**
       * Ожидание CDP ограничено deadline команды и актуальным grant.
       * После отправки input отзыв означает неизвестный исход эффекта.
       */
      const send: NativeBrowserView['send'] = async (method, params) => {
        const current = views.get(tabId)?.command;

        if (!current || !allowed(current, tabId)) {
          throw new Error('access_revoked');
        }

        if (method.startsWith('Input.')) {
          views.get(tabId)!.dispatched = true;
        }

        /**
         * Координаты CDP-ввода живут в DIP, а resolve возвращает CSS-точку страницы.
         * Зум вкладки масштабирует отрисовку: без множителя mousedown попадает мимо
         * элемента при любом zoom ≠ 100% — клик «не работает», fill теряет фокус.
         */
        if (method === 'Input.dispatchMouseEvent') {
          params = scaleMouseEvent(views.get(tabId)!.view.state().zoom, params);
        }

        const result = await bounded(view.send(method, params), current, tabId, undefined,
          current.action === 'screenshot' ? 5000 : undefined);

        if (!allowed(current, tabId)) {
          throw new Error('access_revoked');
        }

        return result;
      };
      const bundle = {
        view,
        send,
        command: null as NativeCommand | null,
        dispatched: false,
        protocol: createBrowserProtocol({
          send,
          epoch: () => tabs.get(tabId).pageEpoch,
          allowed: (): boolean => Boolean(bundle.command && allowed(bundle.command, tabId)),
        }),
        driver: null as unknown as ReturnType<typeof createBrowserDriver>,
      };

      bundle.driver = createBrowserDriver({
        allowed: () => Boolean(bundle.command && allowed(bundle.command, tabId)),
        epoch: () => tabs.get(tabId).pageEpoch,
        resolve: bundle.protocol.resolve,
        send,
        act: bundle.protocol.act,
      });
      views.set(tabId, bundle);

      return {
        navigate: view.navigate,
        show: view.show,
        hide: view.hide,
        destroy: () => {
          views.delete(tabId);
          bundle.protocol.reset();
          view.destroy();
        },
      };
    },
  });

  /**
   * Любая смена host/document/machine отнимает прежние grants до следующих эффектов.
   * При техническом reconnect собственную вкладку восстанавливает новый open агента.
   */
  function stopHost(reconnect = false): void {
    host = null;
    completed.clear();

    if (leaseTimer) {
      clearTimeout(leaseTimer);
      leaseTimer = null;
    }

    for (const tab of tabs.list()) {
      tabs.revoke(tab.id, reconnect);
      views.get(tab.id)?.protocol.reset();
    }

    changed();
  }

  /**
   * Native command DTO отделяет trusted metadata от model action payload.
   * Grant — единственная внутренняя команда и требует human flag с exact expected epochs.
   */
  function command(raw: unknown): NativeCommand {
    if (!isPlainRecord(raw)) {
      throw new Error('browser_request_invalid');
    }

    const { requestId, hostId, hostEpoch, owner, grantEpoch, deadline, ...input } = raw;

    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(requestId)
      || typeof hostId !== 'string' || hostId.length < 1 || hostId.length > 160
      || !Number.isSafeInteger(hostEpoch) || Number(hostEpoch) < 1
      || typeof owner !== 'string' || owner.length < 1 || owner.length > 4096
      || !Number.isSafeInteger(grantEpoch) || Number(grantEpoch) < 0
      || typeof deadline !== 'number' || !Number.isFinite(deadline)
      || deadline > now() + 16000) {
      throw new Error('browser_request_invalid');
    }

    if (input.action === 'grant') {
      if (Object.keys(input).sort().join() !== 'action,human,pageEpoch,tabId'
        || input.human !== true || typeof input.tabId !== 'string'
        || !Number.isSafeInteger(input.pageEpoch) || Number(input.pageEpoch) < 1) {
        throw new Error('browser_request_invalid');
      }
    } else {
      parseBrowserAction(input);
    }

    return { ...raw } as unknown as NativeCommand;
  }

  /**
   * Команда использует захваченный grantEpoch, включая время ожидания tab queue.
   * Known no-effect отказы возвращаются envelope, чтобы host мог подтвердить их без timeout.
   */
  async function run(value: NativeCommand): Promise<unknown> {
    if (!globalAllowed(value)) {
      throw new Error('access_revoked');
    }

    if (value.action === 'list') {
      return { ok: true, tabs: tabs.list().filter((tab) =>
        tabs.allowed(tab.id, value.owner, tab.grantEpoch)).map((tab) => ({
        tabId: tab.id,
          url: tab.url,
          grantEpoch: tab.grantEpoch,
          pageEpoch: tab.pageEpoch,
      })) };
    }

    if (value.action === 'open') {
      let openedId = '';
      const pending = tabs.open(browserUrl(value.url), value.owner, true, {
        created: (tabId) => {
          openedId = tabId;
        },
      });
      const tab = await bounded(pending, value, openedId, () => tabs.close(openedId));

      if (!globalAllowed(value) || !tabs.allowed(tab.id, value.owner, tab.grantEpoch)) {
        tabs.revoke(tab.id);

        throw new Error('access_revoked');
      }

      return {
        ok: true,
        tabId: tab.id,
        url: tab.url,
        grantEpoch: tab.grantEpoch,
        pageEpoch: tab.pageEpoch
      };
    }

    const tabId = String(value.tabId ?? '');
    const bundle = views.get(tabId);

    if (!bundle) {
      throw new Error('browser_tab_missing');
    }

    if (value.action === 'grant') {
      const tab = tabs.get(tabId);

      if (tab.grantEpoch !== value.grantEpoch || tab.pageEpoch !== value.pageEpoch) {
        throw new Error('access_revoked');
      }

      tabs.grant(tabId, value.owner);
      bundle.protocol.reset();

      return snapshot();
    }

    if (!allowed(value, tabId)) {
      throw new Error('access_revoked');
    }

    const release = tabs.use(tabId, true);

    bundle.command = value;
    bundle.dispatched = false;

    try {
      if (value.action === 'snapshot') {
        tabs.observe(tabId);

        return { ok: true, ...await bundle.protocol.snapshot() };
      }

      if (value.action === 'screenshot') {
        /**
         * Захват не меняет дерево главного окна и выбранную вкладку. Временный show/hide
         * мерцал поверх чата и отменял новый layout, пришедший во время ожидания.
         */
        const capture = bundle.view.screenshot((method, params) => {
          if (bundle.command !== value) {
            throw new Error('access_revoked');
          }

          return bundle.send(method, params);
        });
        const data = await bounded(capture, value, tabId, undefined, 5000);

        if (!allowed(value, tabId)) {
          throw new Error('access_revoked');
        }

        return { format: 'grigdesk-work-content-v1',
          content: [{
            type: 'image',
            mimeType: 'image/jpeg',
            data
          }] };
      }

      if (value.action === 'console') {
        return {
          ok: true,
          console: bundle.view.console(),
          untrusted: true
        };
      }

      if (value.action === 'close') {
        tabs.close(tabId);

        return { ok: true };
      }

      /**
       * Native-ввод доходит только до показанной на экране вкладки. При
       * смонтированной панели ввод активирует вкладку (render покажет её) и идёт
       * системными событиями; без панели команда исполняется в DOM страницы —
       * ввод работает и при закрытом инструменте браузера, не трогая фокус.
       */
      const input = {
        action: value.action as 'click' | 'fill' | 'scroll',
        pageEpoch: Number(value.pageEpoch),
        ref: value.ref as string | undefined,
        text: value.text as string | undefined,
        deltaY: value.deltaY as number | undefined,
      };

      if (tabs.layoutRect() !== null) {
        if (tabs.activeId() !== tabId) {
          tabs.activate(tabId);
        }

        await bundle.driver.input(input);
      } else {
        await bundle.driver.domInput(input);
      }

      return { ok: true };
    } catch (error) {
      if (bundle.dispatched && (error as Error).message === 'access_revoked') {
        throw new Error('outcome_unknown');
      }

      throw error;
    } finally {
      bundle.command = null;
      release();
    }
  }

  /**
   * Layout проверяет instance/revision до применения и округляет CSS px в DIP.
   * Старое измерение не отменяет более новый synchronous hide.
   */
  function layout(value: Record<string, unknown>, hide = false): void {
    if (!viewport || value.instance !== viewport.instance
      || !Number.isSafeInteger(value.revision) || Number(value.revision) <= viewport.revision) {
      return;
    }

    viewport.revision = Number(value.revision);

    if (hide || value.rect === null) {
      tabs.layout(null);

      return;
    }

    const rect = value.rect;
    const bounds = options.bounds();

    if (!isPlainRecord(rect) || Object.keys(rect).sort().join() !== 'height,width,x,y'
      || !['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number'
        && Number.isFinite(rect[key])) || Number(rect.x) < 0 || Number(rect.y) < 0
      || Number(rect.width) <= 0 || Number(rect.height) <= 0
      || bounds.zoom <= 0 || !Number.isFinite(bounds.zoom)) {
      tabs.layout(null);

      throw new Error('browser_layout_invalid');
    }

    const x = Math.ceil(Number(rect.x) * bounds.zoom);
    const y = Math.ceil(Number(rect.y) * bounds.zoom);
    const right = Math.min(bounds.width, Math.floor((Number(rect.x) + Number(rect.width)) * bounds.zoom));
    const bottom = Math.min(bounds.height,
      Math.floor((Number(rect.y) + Number(rect.height)) * bounds.zoom));
    const target: BrowserRect | null = right > x && bottom > y
      ? {
        x,
        y,
        width: right - x,
        height: bottom - y
      } : null;

    tabs.layout(target);
  }

  /**
   * Строгий operation schema не пропускает данные renderer как generic native вызов.
   * Тот же parser применяется к sync hide, но не открывает sync evaluate/CDP.
   */
  function request(raw: unknown): Record<string, unknown> {
    const fields: Record<string, string[]> = {
      state: [],
      apps: [],
      'choose-app': [],
      preferences: ['value'],
      open: ['url', 'target', 'deduplicate'],
      activate: ['tabId'],
      move: ['tabId', 'beforeId'],
      navigate: ['tabId', 'url'],
      back: ['tabId'],
      forward: ['tabId'],
      reload: ['tabId'],
      close: ['tabId'],
      zoom: ['tabId', 'percent'],
      pause: ['tabId'],
      resume: ['tabId'],
      revoke: ['tabId'],
      execute: ['command'],
      'host-start': ['hostId', 'hostEpoch', 'leaseUntil'],
      'host-stop': ['hostId', 'hostEpoch'],
      'viewport-mount': ['instance'],
      'viewport-unmount': ['instance'],
      layout: ['instance', 'revision', 'rect'],
      hide: ['instance', 'revision'],
      cover: ['instance', 'revision'],
    };

    if (!isPlainRecord(raw) || typeof raw.operation !== 'string' || !Object.hasOwn(fields, raw.operation)
      || Object.keys(raw).some((key) => key !== 'operation'
        && !fields[raw.operation as string]!.includes(key))) {
      throw new Error('browser_request_invalid');
    }

    return raw;
  }

  return {
    snapshot,
    subscribe(listener: () => void) {
      subscribers.add(listener);

      return () => subscribers.delete(listener);
    },
    /**
     * Только актуальный viewport получает кадр выбранной вкладки перед скрытием.
     * Подложка не выдаёт права агенту и не обходит fences обычного layout.
     */
    hide(raw: unknown) {
      const value = request(raw);

      if (value.operation !== 'hide' && value.operation !== 'cover') {
        throw new Error('browser_request_invalid');
      }

      let preview: string | null = null;

      try {
        if (value.operation === 'cover' && viewport && value.instance === viewport.instance
          && Number.isSafeInteger(value.revision) && Number(value.revision) > viewport.revision
          && tabs.layoutRect() !== null) {
          const active = tabs.activeId();

          preview = active ? views.get(active)?.view.preview() ?? null : null;
        }
      } finally {
        // Отказ копирования кадра не оставляет native guest поверх меню.
        // Старые instance/revision по-прежнему не меняют текущий layout.
        layout(value, true);
      }

      return preview;
    },
    hideForResize: () => tabs.layout(null),
    /**
     * Новый документ теряет геометрию и все разрешения прежнего host.
     * Viewport новой страницы должен заново подтвердить свой instance.
     */
    documentChanged() {
      tabs.layout(null);
      viewport = null;
      retiredViewports.clear();
      stopHost();
    },
    machineChanged() {
      stopHost();
      tabs.dispose();
      viewport = null;
    },
    /**
     * Pause/revoke/layout исполняются до первого await, независимо от агентской очереди.
     * Async picker/settings повторяют IPC generation callback после ожидания.
     */
    async invoke(raw: unknown, valid: () => boolean = () => true): Promise<unknown> {
      const value = request(raw);
      const operation = String(value.operation);

      if (!valid() || disposed) {
        throw new Error('browser_sender_forbidden');
      }

      if (host && host.leaseUntil <= now()) {
        stopHost(true);
      }

      if (operation === 'state') {
        return snapshot();
      }

      if (operation === 'apps') {
        const apps = await options.apps();

        if (!valid()) {
          throw new Error('browser_sender_forbidden');
        }

        return apps;
      }

      if (operation === 'choose-app') {
        tabs.layout(null);

        const result = await options.chooseApp();

        if (!valid()) {
          throw new Error('browser_sender_forbidden');
        }

        return result;
      }

      if (operation === 'preferences') {
        const candidate = value.value;
        const next = normalizeBrowserPreferences(candidate);

        if (!isPlainRecord(candidate)
          || Object.keys(candidate).sort().join() !== 'agents,external,open,search'
          || Object.keys(next).some((key) => next[key as keyof BrowserPreferences] !== candidate[key])) {
          throw new Error('browser_request_invalid');
        }

        const pending = preferenceQueue.catch(() => undefined).then(async () => {
          if (!valid()) {
            throw new Error('browser_sender_forbidden');
          }

          await options.commit(next);

          if (!options.preferences().agents) {
            stopHost();
          }

          changed();

          if (!valid()) {
            throw new Error('browser_sender_forbidden');
          }

          return { preferences: { ...options.preferences() }, revision };
        });

        preferenceQueue = pending.then(() => undefined, () => undefined);

        return pending;
      }

      if (operation === 'host-start') {
        if (!options.preferences().agents || typeof value.hostId !== 'string'
          || value.hostId.length < 1 || value.hostId.length > 160
          || !Number.isSafeInteger(value.hostEpoch) || Number(value.hostEpoch) < 1
          || typeof value.leaseUntil !== 'number' || value.leaseUntil <= now()
          || value.leaseUntil > now() + 16000) {
          throw new Error('browser_request_invalid');
        }

        if (host && (host.hostId !== value.hostId || host.hostEpoch !== value.hostEpoch)) {
          stopHost(true);
        }

        host = {
          hostId: value.hostId,
          hostEpoch: Number(value.hostEpoch),
          leaseUntil: value.leaseUntil
        };

        if (leaseTimer) {
          clearTimeout(leaseTimer);
        }

        const expected = host;

        leaseTimer = setTimeout(() => {
          if (host === expected && host.leaseUntil <= now()) {
            stopHost(true);
          }
        }, Math.max(1, host.leaseUntil - now()));
        leaseTimer.unref?.();

        return snapshot();
      }

      if (operation === 'host-stop') {
        if (host && host.hostId === value.hostId && host.hostEpoch === value.hostEpoch) {
          stopHost(true);
        }

        return snapshot();
      }

      if (operation === 'viewport-mount') {
        if (typeof value.instance !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.instance)
          || retiredViewports.has(value.instance)) {
          throw new Error('browser_request_invalid');
        }

        if (viewport?.instance !== value.instance) {
          if (viewport) {
            retiredViewports.add(viewport.instance);
          }

          viewport = { instance: value.instance, revision: 0 };
          tabs.layout(null);
        }

        return snapshot();
      }

      if (operation === 'viewport-unmount') {
        if (viewport && viewport.instance === value.instance) {
          retiredViewports.add(viewport.instance);
          viewport = null;
          tabs.layout(null);
        }

        return snapshot();
      }

      if (operation === 'layout') {
        layout(value);

        return snapshot();
      }

      if (operation === 'execute') {
        const native = command(value.command);

        validations.set(native, valid);

        if (!globalAllowed(native)) {
          return { ok: false, error: 'access_revoked' };
        }

        const cacheKey = JSON.stringify([native.hostId, native.hostEpoch, native.requestId]);
        const previous = completed.get(cacheKey);

        if (previous) {
          if (native.tabId && !['grant', 'close'].includes(native.action) && !allowed(native, native.tabId)) {
            return { ok: false, error: 'access_revoked' };
          }

          return previous;
        }

        const pending = enqueue(native.tabId ?? `owner:${native.owner}`, async () => {
          try {
            if (!valid()) {
              throw new Error('access_revoked');
            }

            return await run(native);
          } catch (error) {
            const code = (error as Error).message;

            const known = /^browser_[a-z_]+$/u.test(code) || [
              'access_revoked', 'stale_page', 'stale_element', 'invalid_fill', 'outcome_unknown',
            ].includes(code);

            const fallback = native.action === 'screenshot'
              ? 'browser_capture_failed' : 'browser_unavailable';

            return { ok: false, error: known ? code : fallback };
          }
        });

        completed.set(cacheKey, pending);

        if (completed.size > 128) {
          const oldest = completed.keys().next().value;

          if (oldest) {
            completed.delete(oldest);
          }
        }

        return pending;
      }

      if (operation === 'open') {
        if (typeof value.url !== 'string' || !['internal', 'external'].includes(String(value.target))
          || value.deduplicate !== undefined && typeof value.deduplicate !== 'boolean') {
          throw new Error('browser_request_invalid');
        }

        if (value.target === 'external') {
          await options.external(options.preferences().external, browserUrl(value.url));
        } else {
          await tabs.open(value.url === '' ? '' : browserUrl(value.url), null,
            value.deduplicate !== false);
        }

        if (!valid()) {
          throw new Error('browser_sender_forbidden');
        }

        return snapshot();
      }

      if (typeof value.tabId !== 'string') {
        throw new Error('browser_request_invalid');
      }

      const tabId = value.tabId;

      tabs.get(tabId);

      if (operation === 'activate') {
        tabs.activate(tabId);
      } else if (operation === 'move') {
        if (value.beforeId !== null && typeof value.beforeId !== 'string') {
          throw new Error('browser_request_invalid');
        }

        tabs.move(tabId, value.beforeId);
      } else if (operation === 'pause' || operation === 'resume') {
        tabs.pause(tabId, operation === 'pause');
        views.get(tabId)!.protocol.reset();
      } else if (operation === 'revoke') {
        tabs.revoke(tabId);
        views.get(tabId)!.protocol.reset();
      } else if (operation === 'close') {
        tabs.close(tabId);
      } else if (operation === 'navigate') {
        const release = tabs.use(tabId);

        try {
          await views.get(tabId)!.view.navigate(browserUrl(value.url));
        } finally {
          release();
        }
      } else if (operation === 'back' || operation === 'forward') {
        tabs.touch(tabId);
        views.get(tabId)!.view.history(operation === 'back' ? -1 : 1);
      } else if (operation === 'reload') {
        tabs.touch(tabId);
        views.get(tabId)!.view.reload();
      } else if (operation === 'zoom') {
        if (typeof value.percent !== 'number' || !Number.isFinite(value.percent)
          || value.percent < 25 || value.percent > 300) {
          throw new Error('browser_request_invalid');
        }

        views.get(tabId)!.view.zoom(value.percent / 100);
      } else {
        throw new Error('browser_request_invalid');
      }

      return snapshot();
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        stopHost();
        tabs.dispose();
        subscribers.clear();
      }
    },
  };
}
