import { defineStore } from 'pinia';
import { computed, watch, onScopeDispose, ref, shallowRef } from 'vue';
import { createSettingsSession } from '../features/settings/session.ts';
import {
  DEFAULT_SETTINGS_PAGE,
  SETTINGS_FIELDS,
  getSettingsFields,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  SETTINGS_PAGE_KEY,
  resolveFieldAddress,
  resolveSettingsPage,
  normalizeSettingsPageId,
  equalFieldAddress,
  type SettingsFieldMetadata,
} from '../features/settings/catalog.ts';
import {
  publicFieldMetadata,
  type SettingsSearchResult,
} from '../features/settings/search.ts';
import type { FieldAddress } from '../features/settings/contracts.ts';
import { uiLocale, hasOpenModal, messageRef, resolveUiText, type UiText } from '../ui.ts';

export interface SettingsOpenRequest {
  source?: 'shortcut' | 'menu' | 'button' | 'link' | 'route';
  pageId?: string;
  queryPage?: string;
  entityId?: string;
}

/**
 * Недоступность storage не мешает открыть форму в памяти.
 * Чтение выполняется только по действию, без браузерного эффекта при импорте.
 */
function navigationStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const session = createSettingsSession(undefined, uiLocale);
  const snapshot = shallowRef(session.getSnapshot());
  const isOpen = ref(false);
  const pageId = ref(DEFAULT_SETTINGS_PAGE);
  const entityId = ref<string | undefined>();
  const tabId = ref<string | undefined>();
  const closeChoiceOpen = ref(false);
  const revealTarget = shallowRef<FieldAddress | null>(null);
  const query = ref('');
  const navigationMessage = shallowRef<UiText>('');
  const navigationError = computed(() => resolveUiText(navigationMessage.value));
  const pendingOpen = shallowRef<SettingsOpenRequest | null>(null);
  const dynamicCatalogs = shallowRef<Record<string, SettingsFieldMetadata[]>>({});
  const dynamicFields = computed(() => Object.values(dynamicCatalogs.value).flat());
  const expandedGroups = ref<string[]>(['interface']);
  const resourceDetails = shallowRef<Record<string, Record<string, string | number | boolean>>>({});
  let authenticated = false;
  let pendingAction: { run: () => Promise<boolean>; resolve: (ok: boolean) => void } | null = null;
  const actionRunning = ref(false);
  let closeChoiceRunning = false;
  const bindings = new Map<string, () => void>();
  const services = new Map<string, unknown>();

  /**
   * Контроллеры чтения и операций живут рядом с сессией вне сериализуемого state.
   * Страница получает прежний экземпляр при возврате, а закрытие освобождает его ссылки.
   */
  function sessionService<T>(key: string, create: () => T): T {
    if (!services.has(key)) {
      services.set(key, create());
    }

    return services.get(key) as T;
  }

  /**
   * Подписки ресурсов принадлежат открытию, а не смонтированной странице.
   * Смена страницы сохраняет наблюдение, закрытие снимает все обработчики.
   */
  function bindSession(key: string, setup: () => () => void): void {
    if (!bindings.has(key)) {
      bindings.set(key, setup());
    }
  }

  function releaseBindings(): void {
    for (const cleanup of bindings.values()) {
      cleanup();
    }

    bindings.clear();
    services.clear();
  }

  const unsubscribe = session.subscribe(() => {
    snapshot.value = session.getSnapshot();
  });

  /**
   * Старый install ID нормализуется до проверки видимого каталога страниц.
   * Хранилище и entity остаются прежними; открытие не запускает отдельный диалог.
   */
  function selectPage(id: string, entity?: string, tab?: string): boolean {
    const selected = normalizeSettingsPageId(id);

    if (!selected) {
      navigationMessage.value = messageRef('settings.settingsSectionNoLongerAvailable');

      return false;
    }

    pageId.value = selected;
    entityId.value = entity;
    tabId.value = tab;
    navigationMessage.value = '';

    const group = SETTINGS_PAGES.find((page) => page.id === selected)?.groupId;

    if (group && !expandedGroups.value.includes(group)) {
      expandedGroups.value.push(group);
    }

    try {
      navigationStorage()?.setItem(SETTINGS_PAGE_KEY, selected);
    } catch {
      // Выбор страницы сохраняется в памяти до закрытия документа.
    }

    return true;
  }

  /**
   * Клавиша и меню не забирают фокус чужого модала; повтор не начинает новую сессию.
   * Запрос до входа запоминается один раз и исполняется после подтверждённой авторизации.
   */
  function requestOpen(request: SettingsOpenRequest = {}): boolean {
    const source = request.source ?? 'button';

    if (!isOpen.value && ['shortcut', 'menu'].includes(source) && hasOpenModal()) {
      return false;
    }

    if (!authenticated) {
      pendingOpen.value = { ...request, source };

      return false;
    }

    if (isOpen.value) {
      const selected = normalizeSettingsPageId(request.pageId) ?? normalizeSettingsPageId(request.queryPage);

      if (selected) {
        selectPage(selected, request.entityId);
      }

      return true;
    }

    const selected = resolveSettingsPage({
      pageId: request.pageId,
      queryPage: request.queryPage,
      storage: navigationStorage(),
    });

    try {
      const saved = JSON.parse(navigationStorage()?.getItem('grigdesk-settings-tree') ?? '[]');

      if (Array.isArray(saved)) {
        expandedGroups.value = saved.filter((id) => SETTINGS_GROUPS.some((group) => group.id === id));
      }
    } catch {
      // Повреждённый ключ не препятствует открытию выбранной страницы.
    }

    releaseBindings();
    session.begin();
    selectPage(selected, request.entityId);
    isOpen.value = true;
    pendingOpen.value = null;

    return true;
  }

  /**
   * Закрытие освобождает секреты, состояние поиска и отложенный запрос открытия.
   * Потеря входа дополнительно запрещает новое открытие до подтверждения авторизации.
   */
  function dispose(reason = 'close'): void {
    pendingAction?.resolve(false);
    pendingAction = null;
    releaseBindings();
    session.dispose(reason);
    isOpen.value = false;
    closeChoiceOpen.value = false;
    revealTarget.value = null;
    pendingOpen.value = null;
    query.value = '';
    navigationMessage.value = '';
    entityId.value = undefined;
    tabId.value = undefined;
    dynamicCatalogs.value = {};
    resourceDetails.value = {};

    if (reason === 'auth-lost') {
      authenticated = false;
    }
  }

  /**
   * Первичная проверка входа не стирает route-запрос, ожидающий её завершения.
   * После настоящей потери входа прежнее намерение больше не восстанавливается.
   */
  function setAuthenticated(value: boolean): void {
    const wasAuthenticated = authenticated;

    authenticated = value;

    if (!value && wasAuthenticated) {
      dispose('auth-lost');
    } else if (value && pendingOpen.value) {
      requestOpen(pendingOpen.value);
    }
  }

  function reveal(address: FieldAddress): void {
    const target = resolveFieldAddress(address);

    if (target && selectPage(target.pageId, target.entityId, target.tabId)) {
      revealTarget.value = target;
    }
  }

  /**
   * Каталоги содержат только подписи, адреса и признаки доступности, без значений.
   * Повторная загрузка заменяет каталог владельца и убирает исчезнувшие сущности.
   */
  function setDynamicFields(owner: string, fields: SettingsFieldMetadata[]): void {
    const next = fields.map(publicFieldMetadata).filter((field) => field !== null);
    const retained = (dynamicCatalogs.value[owner] ?? []).filter((previous) =>
      !next.some((field) => equalFieldAddress(field.address, previous.address))
      && snapshot.value.resources.some((resource) => resource.fields.some((field) =>
        field.dirty && equalFieldAddress(field.address, previous.address))));

    dynamicCatalogs.value = {
      ...dynamicCatalogs.value,
      [owner]: [...next, ...retained.map((field) => ({ ...field, available: false }))],
    };
  }

  /**
   * Сохраняется только список известных ID групп, без состояния формы и поиска.
   * Ошибка storage оставляет раскрытие рабочим в текущем документе.
   */
  function setGroupExpanded(id: string, expanded: boolean): void {
    expandedGroups.value = expanded
      ? [...new Set([...expandedGroups.value, id])]
      : expandedGroups.value.filter((group) => group !== id);

    try {
      navigationStorage()?.setItem('grigdesk-settings-tree', JSON.stringify(expandedGroups.value));
    } catch {
      // Дерево остаётся доступным без сохранения между открытиями.
    }
  }

  function fieldMetadata(address: FieldAddress): SettingsFieldMetadata | undefined {
    return [...getSettingsFields(uiLocale.value), ...dynamicFields.value].find((field) =>
      equalFieldAddress(field.address, address));
  }

  /**
   * Между выдачей и кликом сущность могла исчезнуть из каталога.
   * В таком случае открывается безопасная страница без устаревшей entity.
   */
  function openSearchResult(result: SettingsSearchResult): void {
    if (result.address && (!fieldMetadata(result.address)
        || fieldMetadata(result.address)?.available === false)) {
      selectPage(result.pageId);
      navigationMessage.value = messageRef('settings.fieldOrEntityNoLongerAvailable');

      return;
    }

    if (result.address) {
      reveal(result.address);
    } else {
      selectPage(result.pageId);
    }
  }

  /**
   * Пока идёт запись, крестик и Escape не скрывают форму и не создают второй вопрос.
   * Затемнение игнорируется независимо от наличия изменений.
   */
  function requestClose(reason = 'action'): void {
    if (!isOpen.value || reason === 'backdrop' || snapshot.value.applying || actionRunning.value) {
      return;
    }

    if (snapshot.value.dirtyCount) {
      closeChoiceOpen.value = true;
    } else {
      dispose();
    }
  }

  function cancel(): void {
    if (!snapshot.value.applying && !actionRunning.value) {
      dispose('cancel');
    }
  }

  /**
   * Валидация и исход записи принадлежат модели, форма только показывает первый адрес ошибки.
   * Запоздалый результат не закрывает новое открытие и не переключает его страницу.
   */
  async function apply(mode: 'apply' | 'ok' = 'apply') {
    const opening = snapshot.value.sessionId;
    const result = await session.apply(mode);

    if (!isOpen.value || snapshot.value.sessionId !== opening) {
      return result;
    }

    const firstError = result.validation[0]?.address
      ?? result.remaining.find((field) => field.resourceId === result.errors[0]?.resourceId)?.address;

    if (firstError) {
      reveal(firstError);
    }

    if (result.shouldClose) {
      dispose('ok');
    }

    return result;
  }

  /**
   * Три варианта закрытия являются одним выбором, без цепочки бинарных подтверждений.
   * Неуспешное применение оставляет исходную форму с её неприменённым вводом.
   */
  async function chooseClose(choice: 'apply' | 'discard' | 'continue'): Promise<void> {
    if (closeChoiceRunning) {
      return;
    }

    closeChoiceRunning = true;
    closeChoiceOpen.value = false;

    const action = pendingAction;
    const opening = snapshot.value.sessionId;

    try {
      if (action) {
        if (choice === 'continue') {
          action.resolve(false);
          pendingAction = null;
        } else {
          if (choice === 'apply') {
            const result = await apply();

            if (result.remaining.length || result.validation.length) {
              action.resolve(false);

              if (pendingAction === action) {
                pendingAction = null;
              }

              return;
            }
          }

          if (pendingAction === action && snapshot.value.sessionId === opening && isOpen.value) {
            await performAction();
          }
        }
      } else if (choice === 'apply') {
        await apply('ok');
      } else if (choice === 'discard') {
        cancel();
      }
    } finally {
      closeChoiceRunning = false;
    }
  }

  /**
   * Переход к инструменту ждёт того же трёхвариантного выбора, что и закрытие.
   * Ошибка действия оставляет настройки открытыми; повторный клик не дублирует запуск.
   */
  function requestAction(run: () => Promise<boolean>): Promise<boolean> {
    if (!isOpen.value || snapshot.value.applying || pendingAction || actionRunning.value) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      pendingAction = { run, resolve };

      if (snapshot.value.dirtyCount) {
        closeChoiceOpen.value = true;
      } else {
        void performAction();
      }
    });
  }

  /**
   * Доставка действия подтверждается до очистки модала и его неприменённого ввода.
   * Потеря авторизации или закрытие во время ожидания не открывает новую сессию.
   */
  async function performAction(): Promise<void> {
    const action = pendingAction;
    const opening = snapshot.value.sessionId;

    if (!action || actionRunning.value) {
      return;
    }

    actionRunning.value = true;

    try {
      const ok = await action.run();

      if (isOpen.value && snapshot.value.sessionId === opening) {
        action.resolve(ok);
        pendingAction = null;

        if (ok) {
          dispose('action');
        } else {
          navigationMessage.value = messageRef('settings.couldNotOpenActionSettingsRemainOpen');
        }
      }
    } catch {
      action.resolve(false);
      pendingAction = null;
      navigationMessage.value = messageRef('settings.couldNotOpenActionSettingsRemainOpen');
    } finally {
      actionRunning.value = false;
    }
  }

  watch(uiLocale, () => snapshot.value = session.getSnapshot());

  onScopeDispose(() => {
    releaseBindings();
    unsubscribe();
    session.dispose();
  });

  return {
    snapshot,
    isOpen,
    pageId,
    entityId,
    tabId,
    closeChoiceOpen,
    revealTarget,
    query,
    navigationError,
    pendingOpen,
    bindSession,
    sessionService,
    dynamicFields,
    expandedGroups,
    resourceDetails,
    setGroupExpanded,
    setDynamicFields,
    fieldMetadata,
    openSearchResult,
    setAuthenticated,
    requestOpen,
    selectPage,
    reveal,
    registerResource: session.register,
    loadResource: session.load,
    setField: session.setField,
    unsetField: session.unsetField,
    getValue: session.getValue,
    getIntent: session.getIntent,
    getBaseline: session.getBaseline,
    acceptSnapshot: session.acceptSnapshot,
    resolveConflict: session.resolveConflict,
    discardField: session.discardField,
    stopWaiting: session.stopWaiting,
    dispose,
    cancel,
    requestClose,
    requestAction,
    actionRunning,
    chooseClose,
    apply,
  };
});
