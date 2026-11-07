import { BROWSER_TAB_IDLE_TIMEOUT_MS } from '../../../shared/browser/browserLimits.ts';

export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TabView {
  navigate(url: string): Promise<void>;
  show(rect: BrowserRect): void;
  hide(): void;
  destroy(): void;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  agentWorking: boolean;
  loading: boolean;
  error: string;
  owner: string | null;
  creator: 'human' | 'agent';
  grantee: string | null;
  grantOrigin: string | null;
  grantEpoch: number;
  pageEpoch: number;
  paused: boolean;
  navigating: boolean;
}

interface Entry extends Omit<BrowserTab, 'agentWorking'> {
  scope: string;
  reconnectOrigin: string | null;
  lastUsedAt: number;
  uses: number;
  agentUses: number;
  view: TabView;
}

/**
 * У пустой human tab нет web-origin и потому нет implicit agent grant.
 * Все HTTP(S) URL проверяет API до помещения в этот реестр.
 */
export function browserTabOrigin(url: string): string | null {
  return url ? new URL(url).origin : null;
}

/**
 * Реестр принадлежит main и переживает уход Vue из раздела браузера.
 * Все grant/navigation изменения синхронны, а view не входит в public metadata.
 */
export function createBrowserTabs(port: {
  id(): string;
  create(id: string, scope: string): TabView;
  changed?(): void;
  now?(): number;
}) {
  const now = port.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let active: string | null = null;
  let visible: string | null = null;
  let layout: BrowserRect | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const required = (id: string): Entry => {
    const tab = entries.get(id);

    if (!tab) {
      throw new Error('browser_tab_missing');
    }

    return tab;
  };
  const publicTab = ({
    view: _view, scope: _scope, reconnectOrigin: _reconnectOrigin,
    lastUsedAt: _lastUsedAt, uses: _uses, agentUses, ...tab
  }: Entry): BrowserTab => ({ ...tab, agentWorking: agentUses > 0 });

  /**
   * Один таймер следит только за простаивающими агентскими вкладками.
   * Человеческие вкладки, показанная страница и незавершённые команды сохраняются.
   */
  function scheduleCleanup(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    let deadline = Infinity;

    for (const tab of entries.values()) {
      if (tab.creator === 'agent' && tab.uses === 0 && tab.id !== visible) {
        deadline = Math.min(deadline, tab.lastUsedAt + BROWSER_TAB_IDLE_TIMEOUT_MS);
      }
    }

    if (Number.isFinite(deadline)) {
      idleTimer = setTimeout(closeIdleTabs, Math.max(1, deadline - now()));
      idleTimer.unref?.();
    }
  }

  /**
   * Проверка повторяется в момент срабатывания, поэтому новое обращение спасает вкладку.
   * Фоновые metadata/navigation и host heartbeat не считаются использованием страницы.
   */
  function closeIdleTabs(): void {
    idleTimer = null;

    for (const tab of [...entries.values()]) {
      if (tab.creator === 'agent' && tab.uses === 0 && tab.id !== visible
        && now() - tab.lastUsedAt >= BROWSER_TAB_IDLE_TIMEOUT_MS) {
        close(tab.id);
      }
    }

    scheduleCleanup();
  }

  /**
   * Явное обращение к странице начинает новый период простоя.
   * Чтение общего списка и техническое обновление состояния сюда не попадают.
   */
  function touch(id: string): void {
    required(id).lastUsedAt = now();
    scheduleCleanup();
  }

  /**
   * Изменение active немедленно скрывает прежнюю native поверхность.
   * Текущий безопасный layout можно повторно применить только в этой странице.
   */
  function render(): void {
    const nextVisible = layout ? active : null;
    const previous = visible === null ? undefined : entries.get(visible);

    if (visible !== nextVisible && previous) {
      previous.lastUsedAt = now();
    }

    visible = nextVisible;

    for (const tab of entries.values()) {
      if (layout && tab.id === active) {
        tab.view.show(layout);
      } else {
        tab.view.hide();
      }
    }

    scheduleCleanup();
    port.changed?.();
  }

  /**
   * Закрытие удаляет вкладку до уничтожения native view.
   * Активная поверхность выбирается заново из оставшихся вкладок.
   */
  function close(id: string): void {
    const tab = required(id);

    entries.delete(id);
    tab.view.destroy();

    if (active === id) {
      active = entries.keys().next().value ?? null;
    }

    render();
  }

  return {
    list: () => [...entries.values()].map(publicTab),
    activeId: () => active,
    /**
     * Текущий rect смонтированной панели браузера: null, когда инструмент браузера
     * закрыт и показать вкладку в окне нечем. Ввод агента опирается на это состояние.
     */
    layoutRect: () => layout,
    get: (id: string) => publicTab(required(id)),
    scope: (id: string) => required(id).scope,
    touch,
    /**
     * Выполняемая команда удерживает вкладку независимо от срока простоя.
     * После её завершения начинается полный срок; закрытая вкладка не восстанавливается.
     */
    use(id: string, agent = false) {
      const tab = required(id);
      let released = false;

      tab.uses += 1;
      tab.agentUses += Number(agent);
      scheduleCleanup();

      if (agent) {
        port.changed?.();
      }

      return () => {
        if (released || entries.get(id) !== tab) {
          return;
        }

        released = true;
        tab.uses -= 1;
        tab.agentUses -= Number(agent);
        touch(id);

        if (agent) {
          port.changed?.();
        }
      };
    },
    effectiveOwner(id: string) {
      const tab = required(id);

      return tab.grantee ?? tab.owner;
    },
    /**
     * Agent dedup не восстанавливает отозванное разрешение существующей вкладки.
     * Новый private scope выбирает caller; popup передаёт scope исходной session.
     */
    async open(url: string, owner: string | null, deduplicate = true, options: {
      scope?: string;
      authorized?: boolean;
      created?(id: string): void;
    } = {}) {
      const existing = deduplicate
        ? [...entries.values()].find((tab) => tab.url === url && tab.owner === owner) : undefined;

      if (existing) {
        // Новый open восстанавливает только собственную вкладку после потери host.
        // Ручной отзыв, передача и смена origin стирают право такого восстановления.
        if (owner !== null && existing.reconnectOrigin === browserTabOrigin(url)
          && !existing.navigating) {
          existing.grantOrigin = existing.reconnectOrigin;
          existing.reconnectOrigin = null;
          existing.paused = false;
          existing.grantEpoch += 1;
        }

        if (owner !== null && (existing.paused || !existing.grantOrigin
          || existing.grantee !== null && existing.grantee !== owner)) {
          throw new Error('access_revoked');
        }

        touch(existing.id);
        active = existing.id;
        render();

        return publicTab(existing);
      }

      const id = port.id();
      const scope = options.scope ?? (owner === null ? 'human' : owner);
      const authorized = owner !== null && options.authorized !== false;
      const tab: Entry = {
        id,
        scope,
        reconnectOrigin: null,
        lastUsedAt: now(),
        uses: 1,
        agentUses: authorized ? 1 : 0,
        url,
        owner,
        creator: owner === null ? 'human' : 'agent',
        title: '',
        favicon: null,
        loading: true,
        error: '',
        grantee: null,
        grantOrigin: authorized ? browserTabOrigin(url) : null,
        grantEpoch: 1,
        pageEpoch: 1,
        paused: !authorized && owner !== null,
        navigating: true,
        view: port.create(id, scope),
      };

      entries.set(id, tab);
      options.created?.(id);

      try {
        await tab.view.navigate(url);

        if (!entries.has(id)) {
          throw new Error('browser_tab_missing');
        }

        tab.navigating = false;
        tab.loading = false;
        tab.uses -= 1;
        tab.agentUses -= Number(authorized);
        tab.lastUsedAt = now();
        active = id;
        render();

        return publicTab(tab);
      } catch (error) {
        if (entries.delete(id)) {
          tab.view.destroy();
        }

        scheduleCleanup();
        port.changed?.();

        throw error;
      }
    },
    activate(id: string) {
      touch(id);
      active = id;
      render();
    },
    /**
     * Порядок принадлежит native-реестру и сохраняется при следующих snapshot.
     * Перенос не меняет активную страницу, разрешения и живые native views.
     */
    move(id: string, beforeId: string | null) {
      const tab = required(id);

      if (beforeId === id) {
        return;
      }

      if (beforeId !== null) {
        required(beforeId);
      }

      const ordered = [...entries.values()].filter((entry) => entry.id !== id);
      const index = beforeId === null ? ordered.length : ordered.findIndex((entry) => entry.id === beforeId);

      ordered.splice(index, 0, tab);
      entries.clear();

      for (const entry of ordered) {
        entries.set(entry.id, entry);
      }

      port.changed?.();
    },
    layout(rect: BrowserRect | null) {
      layout = rect;
      render();
    },
    /**
     * Передача разрешена только завершившей навигацию web-странице.
     * Новая эпоха немедленно инвалидирует ранее захваченные команды.
     */
    grant(id: string, owner: string) {
      const tab = required(id);

      if (tab.navigating || !browserTabOrigin(tab.url)) {
        throw new Error('browser_navigation_pending');
      }

      tab.reconnectOrigin = null;
      tab.grantee = owner;
      tab.grantOrigin = browserTabOrigin(tab.url);
      tab.paused = false;
      tab.grantEpoch += 1;
      touch(id);
      port.changed?.();

      return tab.grantEpoch;
    },
    /**
     * Отзыв синхронно закрывает прежние команды. Только технический reconnect
     * сохраняет origin собственной вкладки для нового явного open владельца.
     */
    revoke(id: string, reconnect = false) {
      const tab = required(id);
      const ownGrant = tab.owner !== null && !tab.paused
        && (tab.grantee === null || tab.grantee === tab.owner)
        && tab.grantOrigin === browserTabOrigin(tab.url);

      tab.reconnectOrigin = reconnect
        ? tab.reconnectOrigin ?? (ownGrant ? tab.grantOrigin : null) : null;

      tab.grantee = null;
      tab.grantOrigin = null;
      tab.paused = true;
      tab.grantEpoch += 1;
      port.changed?.();
    },
    /**
     * Пауза меняется вне очереди исполнения вкладки.
     * Новая эпоха останавливает следующие эффекты прежней команды.
     */
    pause(id: string, paused: boolean) {
      const tab = required(id);

      tab.reconnectOrigin = null;
      tab.paused = paused;
      tab.grantEpoch += 1;
      port.changed?.();
    },
    allowed(id: string, owner: string, epoch: number) {
      const tab = entries.get(id);

      return Boolean(tab && !tab.paused && !tab.navigating && tab.grantEpoch === epoch
        && tab.grantOrigin !== null && tab.grantOrigin === browserTabOrigin(tab.url)
        && (tab.grantee ?? tab.owner) === owner);
    },
    /**
     * Начало навигации немедленно делает старое наблюдение недействительным.
     * До завершения загрузки новые действия блокируются navigating.
     */
    beginNavigation(id: string) {
      const tab = required(id);

      tab.navigating = true;
      tab.loading = true;
      tab.error = '';
      tab.pageEpoch += 1;
      port.changed?.();
    },
    /**
     * Завершение навигации публикует актуальные URL и состояние загрузки.
     * Смена origin снимает разрешение до новой явной передачи человеком.
     */
    navigated(id: string, url: string) {
      const tab = required(id);

      if (tab.reconnectOrigin !== browserTabOrigin(url)) {
        tab.reconnectOrigin = null;
      }

      tab.url = url;
      tab.navigating = false;
      tab.loading = false;

      if (tab.grantOrigin !== null && tab.grantOrigin !== browserTabOrigin(url)) {
        tab.grantee = null;
        tab.grantOrigin = null;
        tab.paused = true;
        tab.grantEpoch += 1;
      }

      port.changed?.();
    },
    metadata(id: string, value: Partial<Pick<BrowserTab, 'title' | 'favicon' | 'loading' | 'error'>>) {
      Object.assign(required(id), value);
      port.changed?.();
    },
    /**
     * Каждый snapshot получает новую эпоху наблюдения страницы.
     * Ранее выданные refs не используются для следующего наблюдения.
     */
    observe(id: string) {
      const tab = required(id);

      tab.pageEpoch += 1;
      port.changed?.();

      return tab.pageEpoch;
    },
    close,
    /**
     * Очистка сначала снимает публичные ссылки на все вкладки.
     * Каждая сохранённая native поверхность уничтожается ровно один раз.
     */
    dispose() {
      const previous = [...entries.values()];

      entries.clear();
      active = null;
      visible = null;
      layout = null;
      scheduleCleanup();

      for (const tab of previous) {
        tab.view.destroy();
      }

      port.changed?.();
    },
  };
}
