import { localeMessage, localeTranslator, type LocaleSource } from '../../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../../shared/i18n/catalogs.ts';
import type {
  JsonValue,
  ProviderSettingNode,
  ProviderSettingsCatalog,
} from '../../../../../shared/chat/providerSettingsContracts.ts';
import type {
  ProviderEntry,
  ProviderCredentialEntry,
  ProviderSettingEntry,
} from '../../../../../shared/chat/providersContracts.ts';
import { decodeSettingsJson } from '../../../../../shared/chat/providerSettingsContracts.ts';
import type { useProviderSettingsStore } from '../../../stores/providerSettings.ts';
import type { FieldIntent, FieldResult, ResourceAdapter, SessionField, WriteStatus } from '../contracts.ts';
import { validNativeDraft } from '../nativeValidation.ts';
import { nativeMetadataMessage, providerMetadataMessage } from '../metadataLocale.ts';

export interface ProviderWriteOutcome {
  ok: boolean;
  outcome?: Exclude<WriteStatus, 'success'>;
  status?: number;
  error?: string;
  serverValue?: JsonValue;
}

export interface ProviderStorePort {
  providers: ProviderEntry[];
  loaded: boolean;
  load(refresh?: boolean): Promise<unknown>;
  whenRegistryReady(): Promise<{ ok: boolean; message?: string }>;
  saveSetting(id: string, key: string, value: JsonValue, confirmed?: boolean): Promise<ProviderWriteOutcome>;
  saveCredentials(id: string, values: Record<string, JsonValue>): Promise<ProviderWriteOutcome>;
}

type NativeStore = ReturnType<typeof useProviderSettingsStore>;

/**
 * Группы не становятся адресуемыми объектами, массив остаётся одним атомарным полем.
 * Field id и сегменты пути берутся из публичного каталога без разбора точек и слешей.
 */
export function nativeLeaves(fields: readonly ProviderSettingNode[]): ProviderSettingNode[] {
  return fields.flatMap((field) => field.children?.length ? nativeLeaves(field.children) : [field]);
}

/**
 * Baseline содержит только сохранённые overrides, а не schema default или неизвестный base.
 * Сброс и явный set значения, совпадающего с base, поэтому остаются разными намерениями.
 */
export function nativeValues(catalog: ProviderSettingsCatalog): Record<string, JsonValue> {
  return Object.fromEntries(nativeLeaves(catalog.fields).filter((field) => field.override.state === 'known')
    .map((field) => [
      field.id,
      field.override.state === 'known' ? decodeSettingsJson(field.override.value) : null,
    ]));
}

/**
 * Неактивный override известен по наличию, хотя значение намеренно скрыто сервером.
 * hasStoredValue позволяет поставить unset без выдуманного null в baseline.
 */
export function nativeSessionFields(catalog: ProviderSettingsCatalog,
  locale: LocaleSource = 'ru',
): SessionField[] {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  const unavailable = !['ready', 'partial'].includes(catalog.state) || catalog.schemaRevision === null;

  return [
    ...nativeLeaves(catalog.fields).map((field) => ({
      key: field.id,
      address: {
        pageId: 'agents.providers',
        entityId: catalog.providerId,
        tabId: 'parameters',
        fieldPath: ['native', ...field.path],
      },
      hasStoredValue: field.override.state === 'known',
      ...(!field.writable || unavailable
        ? { unavailable: field.reason ? nativeMetadataMessage(field.reason, 'reasons', locale)
          : messageText("settings.thisParameterCannotBeWrittenRightNow") } : {}),
    })),
    ...catalog.inactiveOverrides.map((field) => ({
      key: field.id,
      address: {
        pageId: 'agents.providers',
        entityId: catalog.providerId,
        tabId: 'parameters',
        fieldPath: ['native', ...field.path],
      },
      hasStoredValue: true,
      unavailable: nativeMetadataMessage(field.reason, 'reasons', locale),
    })),
  ];
}

/**
 * Адаптер не создаёт очередь записей: отдельные поля идут через существующий store CAS.
 * После 409 store перечитывает каталог, а адаптер прекращает оставшиеся поля цепочки.
 */
export function createProviderNativeAdapter(
  id: string,
  store: NativeStore,
  onCatalog: (catalog: ProviderSettingsCatalog) => void = () => {},
  locale: LocaleSource = 'ru',

): ResourceAdapter {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  function catalog(): ProviderSettingsCatalog {
    const value = store.panel(id).catalog;

    if (!value) {
      throw new TypeError(t("settings.providerSettingsCatalogNotReceived"));
    }

    return value;
  }

  function validate(intents: ReadonlyMap<string, FieldIntent>) {
    const current = catalog();
    const fields = nativeLeaves(current.fields);

    return [...intents].flatMap(([key, intent]) => {
      if (intent.op === 'unset') {
        return [];
      }

      const field = fields.find((node) => node.id === key);

      return !field || !field.writable || current.schemaRevision === null
        || !['ready', 'partial'].includes(current.state) || !validNativeDraft(field, intent.value)
        ? [{ key, message: field?.reason ? nativeMetadataMessage(field.reason, 'reasons', locale)
          : messageText("settings.fieldUnavailableOrValueDoesNotMatch") }] : [];
    });
  }

  return {
    id: `providerNative:${id}`,
    chain: `provider:${id}`,
    order: 100,
    sortKey: [id, '2-native'],
    body: 'per-field',
    supportsUnset: true,
    async read(_signal, refresh = false) {
      await store.load(id, refresh);
      onCatalog(catalog());

      return nativeValues(catalog());
    },
    validate,
    /**
     * Повторная проверка учитывает схему, обновлённую предыдущей записью ключей доступа.
     * Подтверждённые поля возвращаются даже при отказе следующего поля того же ресурса.
     */
    async write(intents) {
      const fields: FieldResult[] = [];

      for (const [key, intent] of intents) {
        const issue = validate(new Map([[key, intent]]))[0];

        if (issue) {
          return {
            status: 'failed',
            fields: [...fields, {
              key,
              status: 'failed',
              message: issue.message,
            }],
            message: issue.message,
          };
        }

        const result = await store.commit(id, key, intent.op, intent.op === 'set' ? intent.value : undefined);

        onCatalog(catalog());

        if (!result.ok) {
          return {
            status: result.outcome,
            fields: [...fields, {
              key,
              status: result.outcome,
              message: result.message,
            }],
            message: result.message,
            httpStatus: result.status,
          };
        }

        const values = nativeValues(catalog());

        fields.push({
          key,
          status: 'success',
          ...intent.op === 'set' && Object.hasOwn(values, key) ? { serverValue: values[key] } : {},
        });
      }

      return { status: 'success', fields };
    },
  };
}

/**
 * Реестр перечитывается при каждой операции, чтобы не сохранять снятую декларацию.
 * Отсутствующий провайдер даёт собственную ошибку на текущем языке интерфейса.
 */
function currentProvider(id: string, store: ProviderStorePort,
  locale: LocaleSource = 'ru',
): ProviderEntry {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  const provider = store.providers.find((item) => item.id === id);

  if (!provider) {
    throw new Error(t("settings.providerNoLongerAvailableInTheRegistry"));
  }

  return provider;
}

/**
 * Обычные значения копируются из публичного реестра в baseline.
 * Отсутствующее значение не заменяется выдуманным null.
 */
export function providerSettingValues(provider: ProviderEntry): Record<string, JsonValue> {
  return Object.fromEntries((provider.settings ?? []).filter((field) => field.value !== undefined)
    .map((field) => [field.id, decodeSettingsJson(field.value)]));
}

/**
 * Обычные ручки проверяются по текущей декларации исполнителя перед первым HTTP.
 * Это проверка формы; право подтверждения и окончательная нормализация остаются у сервера.
 */
function validOrdinary(setting: ProviderSettingEntry, value: JsonValue): boolean {
  if (setting.kind === 'toggle') {
    return typeof value === 'boolean';
  }
  if (setting.kind === 'text') {
    return typeof value === 'string';
  }

  return typeof value === 'number' && Number.isFinite(value)
    && (setting.min === undefined || value >= setting.min)
    && (setting.max === undefined || value <= setting.max);
}

/**
 * Обычные параметры сохраняются последовательно в общей цепочке исполнителя.
 * Серверное значение приходит из ответа store, запрос не используется как подтверждение.
 */
export function createProviderSettingsAdapter(
  id: string,
  store: ProviderStorePort,
  registryReady: () => boolean = () => true,
  locale: LocaleSource = 'ru',

): ResourceAdapter {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  return {
    id: `providerSettings:${id}`,
    chain: `provider:${id}`,
    order: 100,
    sortKey: [id, '1-settings'],
    body: 'per-field',
    supportsUnset: false,
    async read(_signal, refresh = false) {
      if (refresh || !store.loaded) {
        await store.load(refresh);
      }

      return providerSettingValues(currentProvider(id, store, locale));
    },
    validate: (intents) => [...intents].flatMap(([key, intent]) => {
      const field = currentProvider(id, store, locale).settings?.find((entry) => entry.id === key);

      return !registryReady() || !field || field.disabled || intent.op !== 'set'
        || !validOrdinary(field, intent.value)
        ? [{ key, message: field?.note ? providerMetadataMessage(id, field.note, locale)
          : messageText("settings.parameterUnavailableReloadTheProviderRegistry") }] : [];
    }),
    /**
     * Новая декларация после credentials может убрать поле из прежнего черновика.
     * Такое поле остаётся неприменённым и не получает старый маршрут записи.
     */
    async write(intents) {
      const fields: FieldResult[] = [];

      for (const [key, intent] of intents) {
        const field = currentProvider(id, store, locale).settings?.find((entry) => entry.id === key);

        if (!registryReady() || !field || field.disabled || intent.op !== 'set') {
          return {
            status: 'failed',
            fields,
            message: messageText("settings.fieldNoLongerAvailableRecheckTheRegistry"),
          };
        }

        const result = await store.saveSetting(id, key, intent.value, intent.confirmed);

        if (!result.ok) {
          return {
            status: result.outcome ?? 'unknown',
            fields,
            message: result.error,
            httpStatus: result.status,
          };
        }

        fields.push({
          key,
          status: 'success',
          ...Object.hasOwn(result, 'serverValue') ? { serverValue: result.serverValue } : {},
        });
      }

      return { status: 'success', fields };
    },
  };
}

/**
 * В baseline доступа попадают только несекретные значения выбора.
 * Серверная маска и наличие ключа не становятся содержимым поля.
 */
export function credentialValues(provider: ProviderEntry): Record<string, JsonValue> {
  return Object.fromEntries((provider.credentials ?? [])
    .filter((field) => field.kind === 'choice' && typeof field.value === 'string')
    .map((field) => [field.env, field.value]));
}

/**
 * Условие видимости вычисляется по полному набору значений выбора с учётом черновика.
 * Секрет никогда не используется для выбора режима и не попадает в публичный результат.
 */
export function credentialVisible(
  field: ProviderCredentialEntry,
  values: Record<string, JsonValue>,
): boolean {
  return !field.when || values[field.when.env] === field.when.value;
}

/**
 * После неизвестного исхода доказательством служит только изменившаяся публичная проекция.
 * Совпадение старого хвоста не доказывает запись и не разрешает повторять секрет автоматически.
 */
function credentialConfirmed(
  before: ProviderCredentialEntry | undefined,
  after: ProviderCredentialEntry | undefined,
  intent: FieldIntent,
): boolean {
  if (!after || intent.op !== 'set') {
    return false;
  }
  if (intent.value === null) {
    return before?.set === true && after.set === false;
  }
  if (after.kind === 'choice') {
    return after.value !== before?.value && after.value === intent.value;
  }

  const changed = before?.set !== after.set || before?.preview !== after.preview;

  return after.set && changed && typeof intent.value === 'string'
    && (!before?.set || intent.value.length >= 16
      && Boolean(after.preview?.endsWith(intent.value.trim().slice(-4))));
}

/**
 * Ключи отправляются одним запросом только из памяти сессии, без отдельного editor draft.
 * Реестр перечитывается до следующих ресурсов этого исполнителя, включая unknown readback.
 */
export function createProviderCredentialsAdapter(
  id: string,
  store: ProviderStorePort,
  onRegistry: (ready: boolean) => Promise<void> = async () => {},
  locale: LocaleSource = 'ru',

): ResourceAdapter {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  return {
    id: `providerCredentials:${id}`,
    chain: `provider:${id}`,
    order: 100,
    sortKey: [id, '0-credentials'],
    body: 'patch',
    supportsUnset: false,
    async read() {
      if (!store.loaded) {
        await store.load();
      }

      return credentialValues(currentProvider(id, store, locale));
    },
    validate: (intents, baseline) => {
      const provider = currentProvider(id, store, locale);
      const values = { ...baseline };

      for (const [key, intent] of intents) {
        if (intent.op === 'set') {
          values[key] = intent.value;
        }
      }

      return [...intents].flatMap(([key, intent]) => {
        const field = provider.credentials?.find((entry) => entry.env === key);
        const valid = field && credentialVisible(field, values) && intent.op === 'set'
          && (field.kind === 'secret' ? intent.value === null
            || typeof intent.value === 'string' && intent.value.trim().length > 0
            : field.options?.some((option) => option.value === intent.value));

        return valid ? [] : [{ key, message: messageText("settings.checkTheAccessFieldAndSelectedMode") }];
      });
    },
    /**
     * ACK разрешает очистить секрет, но обновление схемы также должно завершиться.
     * Подтверждённые ключи не пересылаются после отказа чтения реестра или других параметров.
     */
    async write(intents) {
      const before: ProviderCredentialEntry[] = JSON.parse(
        JSON.stringify(currentProvider(id, store, locale).credentials ?? []),
      );
      const values = Object.fromEntries([...intents].filter(([, intent]) => intent.op === 'set')
        .map(([key, intent]) => [key, intent.op === 'set' ? intent.value : null]));
      const result = await store.saveCredentials(id, values);

      if (!result.ok && result.outcome !== 'unknown') {
        return {
          status: result.outcome ?? 'failed',
          fields: [],
          message: result.error,
          httpStatus: result.status,
        };
      }

      if (!result.ok) {
        await store.load(true);
      }

      const registry = await store.whenRegistryReady();

      await onRegistry(registry.ok);

      const after = store.providers.find((entry) => entry.id === id)?.credentials ?? [];
      const fields: FieldResult[] = [...intents].map(([key, intent]) => {
        const field = after.find((entry) => entry.env === key);
        const confirmed = result.ok
          || credentialConfirmed(before.find((entry) => entry.env === key), field, intent);

        return {
          key,
          status: confirmed ? 'success' : 'unknown',
          ...confirmed && registry.ok && field?.kind === 'choice' && typeof field.value === 'string'
            ? { serverValue: field.value } : {},
        };
      });

      return {
        status: fields.some((field) => field.status !== 'success') ? 'unknown'
          : registry.ok ? 'success' : 'failed',
        fields,
        ...registry.ok ? {} : {
          message: registry.message || messageText("settings.keysSavedReloadTheProviderRegistry"),
        },
      };
    },
  };
}
