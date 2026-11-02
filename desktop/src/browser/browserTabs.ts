import { BROWSER_TAB_LIMIT } from '../../../shared/browser/browserLimits.ts';

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

interface Entry extends BrowserTab {
  scope: string;
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
}) {
  const entries = new Map<string, Entry>();
  let active: string | null = null;
  let layout: BrowserRect | null = null;

  const required = (id: string): Entry => {
    const tab = entries.get(id);

    if (!tab) {
      throw new Error('browser_tab_missing');
    }

    return tab;
  };
  const publicTab = ({ view: _view, scope: _scope, ...tab }: Entry): BrowserTab => ({ ...tab });

  /**
   * Изменение active немедленно скрывает прежнюю native поверхность.
   * Текущий безопасный layout можно повторно применить только в этой странице.
   */
  function render(): void {
    for (const tab of entries.values()) {
      if (layout && tab.id === active) {
        tab.view.show(layout);
      } else {
        tab.view.hide();
      }
    }

    port.changed?.();
  }

  return {
    list: () => [...entries.values()].map(publicTab),
    activeId: () => active,
    get: (id: string) => publicTab(required(id)),
    scope: (id: string) => required(id).scope,
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
        if (owner !== null && (existing.paused || !existing.grantOrigin
          || existing.grantee !== null && existing.grantee !== owner)) {
          throw new Error('access_revoked');
        }

        active = existing.id;
        render();

        return publicTab(existing);
      }

      if (entries.size >= BROWSER_TAB_LIMIT) {
        throw new Error('browser_tab_limit');
      }

      const id = port.id();
      const scope = options.scope ?? (owner === null ? 'human' : owner);
      const authorized = owner !== null && options.authorized !== false;
      const tab: Entry = {
        id,
        scope,
        url,
        owner,
        creator: owner === null ? 'human' : 'agent',
        title: '',
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
        active = id;
        render();

        return publicTab(tab);
      } catch (error) {
        if (entries.delete(id)) {
          tab.view.destroy();
        }

        port.changed?.();

        throw error;
      }
    },
    activate(id: string) {
      required(id);
      active = id;
      render();
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

      tab.grantee = owner;
      tab.grantOrigin = browserTabOrigin(tab.url);
      tab.paused = false;
      tab.grantEpoch += 1;
      port.changed?.();

      return tab.grantEpoch;
    },
    /**
     * Отзыв синхронно снимает получателя и разрешённый origin.
     * Смена эпохи запрещает повторное использование уже выданного grant.
     */
    revoke(id: string) {
      const tab = required(id);

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
    metadata(id: string, value: Partial<Pick<BrowserTab, 'title' | 'loading' | 'error'>>) {
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
    /**
     * Закрытие удаляет вкладку до уничтожения native view.
     * Активная поверхность выбирается заново из оставшихся вкладок.
     */
    close(id: string) {
      const tab = required(id);

      entries.delete(id);
      tab.view.destroy();

      if (active === id) {
        active = entries.keys().next().value ?? null;
      }

      render();
    },
    /**
     * Очистка сначала снимает публичные ссылки на все вкладки.
     * Каждая сохранённая native поверхность уничтожается ровно один раз.
     */
    dispose() {
      const previous = [...entries.values()];

      entries.clear();
      active = null;
      layout = null;

      for (const tab of previous) {
        tab.view.destroy();
      }

      port.changed?.();
    },
  };
}
