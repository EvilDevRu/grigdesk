import { t, uiLocale } from '../../ui.ts';
import { localizeProviderMetadata, localizeNativeMetadata } from './metadataLocale.ts';
import { effectScope, watch } from 'vue';
import type { ProviderEntry } from '../../../../shared/chat/providersContracts.ts';
import type { useSettingsStore } from '../../stores/settings.ts';
import type { useProviderSettingsStore } from '../../stores/providerSettings.ts';
import type { SettingsFieldMetadata } from './catalog.ts';
import {
  createProviderNativeAdapter,
  createProviderCredentialsAdapter,
  createProviderSettingsAdapter,
  credentialValues,
  providerSettingValues,
  nativeSessionFields,
  nativeValues,
  nativeLeaves,
  type ProviderStorePort,
} from './resources/providers.ts';

type SettingsStore = ReturnType<typeof useSettingsStore>;
type NativeStore = ReturnType<typeof useProviderSettingsStore>;

/**
 * Страницы используют одну сессию, доменные stores — только реестр, очередь и CAS.
 * Наблюдение проекций переживает размонтирование страницы и снимается по dispose открытия.
 */
export function createProviderEditor(
  id: string,
  settings: SettingsStore,
  providers: ProviderStorePort,
  native: NativeStore,
) {
  const opening = settings.snapshot.sessionId;
  const scope = effectScope(true);
  let nativeVisited = false;
  let registryReady = true;
  const resourceIds = {
    credentials: `providerCredentials:${id}`,
    settings: `providerSettings:${id}`,
    native: `providerNative:${id}`,
  };
  const ordinaryAdapter = createProviderSettingsAdapter(id, providers, () => registryReady, uiLocale);
  const nativeAdapter = createProviderNativeAdapter(id, native, undefined, uiLocale);
  const credentialsAdapter = createProviderCredentialsAdapter(id, providers, async (ready) => {
    registryReady = ready;
    sync();

    if (nativeVisited && ready) {
      await loadNative(true);
    }
  }, uiLocale);

  function provider(): ProviderEntry | undefined {
    const entry = providers.providers.find((item) => item.id === id);

    return entry ? localizeProviderMetadata(entry, uiLocale.value) : undefined;
  }

  function current(): boolean {
    return settings.isOpen && settings.snapshot.sessionId === opening;
  }

  function loaded(resourceId: string): boolean {
    return settings.snapshot.resources.some((resource) => resource.id === resourceId && resource.loaded);
  }

  /**
   * Индекс содержит подписи и пути, без values, preview и сохранённых secret slots.
   * До ленивой загрузки нативного каталога остаётся явный переход к его загрузке.
   */
  function metadata(): SettingsFieldMetadata[] {
    const entry = provider();
    const source = native.panel(id).catalog;
    const catalog = source ? localizeNativeMetadata(source, uiLocale.value) : null;

    if (!entry) {
      return [];
    }

    const fields: SettingsFieldMetadata[] = [
      ...(entry?.settings ?? []).map((field) => ({
        address: {
          pageId: 'agents.providers',
          entityId: id,
          tabId: 'parameters',
          fieldPath: ['settings', field.id],
        },
        label: field.label,
        description: field.hint ?? '',
        available: registryReady && !field.disabled,
      })),
      ...(entry?.credentials ?? []).map((field) => ({
        address: {
          pageId: 'agents.providers',
          entityId: id,
          tabId: 'access',
          fieldPath: ['credentials', field.env],
        },
        label: field.label,
        description: field.hint ?? '',
        available: true,
      })),
    ];

    if (catalog && nativeVisited) {
      fields.push(...nativeLeaves(catalog.fields).map((field) => ({
        address: {
          pageId: 'agents.providers',
          entityId: id,
          tabId: 'parameters',
          fieldPath: ['native', ...field.path],
        },
        label: field.label,
        description: field.description ?? '',
        synonyms: [field.path.join('.')],
        available: field.writable && ['ready', 'partial'].includes(catalog.state),
      })), ...catalog.inactiveOverrides.map((field) => ({
        address: {
          pageId: 'agents.providers',
          entityId: id,
          tabId: 'parameters',
          fieldPath: ['native', ...field.path],
        },
        label: field.label,
        description: field.reason,
        available: false,
      })));
    } else if (entry?.settingsCatalog) {
      fields.push({
        address: {
          pageId: 'agents.providers',
          entityId: id,
          tabId: 'parameters',
          fieldPath: ['native-catalog'],
        },
        label: t("settings.advancedProviderParametersFor", { entryName: entry.name }),
        get description() {
    return t("settings.searchForTheseFieldsContinuesAfterLoading");
  },
        load: true,
      });
    }

    return fields;
  }

  /**
   * Новая схема не стирает неприменённые поля; register сохраняет их с причиной.
   * Внешний реестр обновляет только исходные снимки уже прочитанных ресурсов.
   */
  function sync(): void {
    if (!current()) {
      return;
    }

    const entry = provider();
    const credentialFields = (entry?.credentials ?? []).map((field) => ({
      key: field.env,
      secret: field.kind === 'secret',
      address: {
        pageId: 'agents.providers',
        entityId: id,
        tabId: 'access',
        fieldPath: ['credentials', field.env],
      },
    }));
    const ordinaryFields = (entry?.settings ?? []).map((field) => ({
      key: field.id,
      address: {
        pageId: 'agents.providers',
        entityId: id,
        tabId: 'parameters',
        fieldPath: ['settings', field.id],
      },
      ...field.disabled || !registryReady
        ? { unavailable: field.note || t("settings.reloadTheProviderRegistry") } : {},
    }));

    settings.registerResource(credentialsAdapter, credentialFields);
    settings.registerResource(ordinaryAdapter, ordinaryFields);

    if (entry && loaded(resourceIds.credentials)) {
      settings.acceptSnapshot(resourceIds.credentials, credentialValues(entry), opening);
    }
    if (entry && loaded(resourceIds.settings)) {
      settings.acceptSnapshot(resourceIds.settings, providerSettingValues(entry), opening);
    }

    const catalog = native.panel(id).catalog;

    if (nativeVisited && catalog) {
      settings.registerResource(nativeAdapter, entry ? nativeSessionFields(catalog, uiLocale) : []);

      if (loaded(resourceIds.native)) {
        settings.acceptSnapshot(resourceIds.native, nativeValues(catalog), opening);
      }
    }

    settings.setDynamicFields(`provider:${id}`, metadata());
  }

  /**
   * Каталог читается при первом раскрытии; force обновляет существующую схему.
   * Регистрация после чтения сохраняет неприменённые поля старой схемы.
   */
  async function loadNative(refresh = false): Promise<void> {
    nativeVisited = true;

    const catalog = native.panel(id).catalog;

    settings.registerResource(nativeAdapter, catalog ? nativeSessionFields(catalog, uiLocale) : []);

    if (refresh) {
      await native.load(id, true);
    }

    if (current()) {
      await settings.loadResource(resourceIds.native);
      sync();
    }
  }

  /**
   * Обновление реестра предшествует каталогу нативных параметров.
   * Ошибка чтения блокирует дальнейшие записи прежних деклараций.
   */
  async function refresh(): Promise<void> {
    await providers.load(true);

    const state = await providers.whenRegistryReady();

    registryReady = state.ok;
    sync();

    if (nativeVisited && registryReady) {
      await loadNative(true);
    }
  }

  sync();
  scope.run(() => {
    watch(() => providers.providers, sync, { flush: 'sync' });
    watch(uiLocale, sync, { flush: 'sync' });
    watch(() => native.panel(id).catalog, sync, { flush: 'sync' });
  });
  settings.bindSession(`provider-editor:${id}`, () => () => scope.stop());

  return {
    resourceIds,
    loadAccess: () => settings.loadResource(resourceIds.credentials),
    loadParameters: () => settings.loadResource(resourceIds.settings),
    loadNative,
    refresh,
    sync,
  };
}
