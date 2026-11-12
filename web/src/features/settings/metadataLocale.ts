import {
  localeMessage, messages, resolveLocaleText, translate, translator, type LocaleSource,
} from '../../../../shared/i18n/catalogs.ts';
import type { UiText } from '../../../../shared/i18n/core.ts';
import type { ProviderEntry, ProviderSettingEntry } from '../../../../shared/chat/providersContracts.ts';
import type { PluginCategory, PluginListItem } from '../../../../shared/plugins/pluginsContracts.ts';
import { localizeProviderAuthLabel } from '../providers/providerLocale.ts';
import type {
  ProviderSettingNode, ProviderSettingsCatalog,
} from '../../../../shared/chat/providerSettingsContracts.ts';

interface ExecutorTypeMetadata {
  id: string;
  label: string;
  hint: string;
}

const BUILTIN_PROVIDERS = new Set(['claude', 'codex', 'deepseek', 'glm', 'kimi', 'tripo', 'qwen']);

/**
 * Собственный вопрос поля удерживает ключ до ответа человека в общем диалоге.
 * Неизвестное подтверждение остаётся исходными данными, как и значение поля.
 */
export function providerSettingConfirmation(
  providerId: string,
  field: ProviderSettingEntry,
  value: unknown,
  locale: LocaleSource = 'ru',
): {
  text: UiText;
  label?: UiText;
  danger?: boolean;
} | undefined {
  const confirmation = value ? field.confirm?.on : field.confirm?.off;

  if (!confirmation || !BUILTIN_PROVIDERS.has(providerId) || field.id !== 'blockDirectSsh' || value) {
    return confirmation;
  }

  const message = localeMessage(locale);

  return {
    ...confirmation,
    text: providerId === 'kimi' ? message('settings.kimiAllowDirectSshConfirm')
      : message('settings.allowDirectSshConfirm'),
    label: message('settings.allowDirectSsh'),
  };
}

/**
 * Собственные пояснения встроенных источников ограничены ID исполнителя и таблицей.
 * Внешний вывод CLI и неизвестная подпись сохраняются, как и серверные сообщения ошибок.
 */
export function providerMetadataMessage(
  providerId: string,
  value: string,
  locale: LocaleSource = 'ru',
): UiText {
  const source = messages.ru.settings.builtinProviderText[
    providerId as keyof typeof messages.ru.settings.builtinProviderText
  ];
  const id = Object.keys(source ?? {}).find((id) => source[id as keyof typeof source] === value);
  const messageText = localeMessage(locale);

  return id ? messageText(`settings.builtinProviderText.${providerId}.${id}`) : value;
}

/**
 * Представление разрешает собственное пояснение на языке текущего чтения.
 * Descriptor нужен сессии, строковая проекция — реактивному render и поиску.
 */
export function localizeProviderText(providerId: string, value: string, locale = 'ru'): string {
  return resolveLocaleText(providerMetadataMessage(providerId, value, locale), locale);
}

/**
 * Типы исполнителей принадлежат приложению, а состав групп остаётся исходным.
 * Перевод проекции не меняет порядок реестра или доступность исполнителей.
 */
export function localizeExecutorType(
  group: ExecutorTypeMetadata,
  locale = 'ru',
): ExecutorTypeMetadata {
  return {
    ...group,
    label: translator.t(locale, `settings.executorTypes.${group.id}.label`, {}, group.label),
    hint: translator.t(locale, `settings.executorTypes.${group.id}.hint`, {}, group.hint),
  };
}

/**
 * Публичная проекция встроенных метаданных определяется владельцем и ID поля.
 * Копируются только подписи: значения, ограничения и исходный DTO сохраняются.
 */
export function localizeProviderMetadata(entry: ProviderEntry, locale = 'ru'): ProviderEntry {
  if (locale === 'ru' || !BUILTIN_PROVIDERS.has(entry.id)) {
    return entry;
  }

  return {
    ...entry,
    authLabel: entry.authLabel === undefined ? undefined
      : localizeProviderAuthLabel(entry, locale),
    distribution: entry.distribution ? {
      ...entry.distribution,
      label: entry.distribution.label === undefined ? undefined : translator.t(locale,
        `settings.builtinProviders.${entry.id}.distribution.label`, {}, entry.distribution.label),
      authHint: entry.distribution.authHint === undefined ? undefined
        : localizeProviderText(entry.id, entry.distribution.authHint, locale),
    } : undefined,
    credentials: entry.credentials?.map((field) => {
      const key = `settings.builtinProviders.${entry.id}.credentials.${field.env}`;

      return {
        ...field,
        label: translator.t(locale, `${key}.label`, {}, field.label),
        hint: field.hint === undefined ? undefined : translator.t(locale, `${key}.hint`, {}, field.hint),
        options: field.options?.map((option) => ({
          ...option,
          label: translator.t(locale, `${key}.options.${option.value}.label`, {}, option.label),
          hint: option.hint === undefined ? undefined
            : translator.t(locale, `${key}.options.${option.value}.hint`, {}, option.hint),
        })),
      };
    }),
    settings: entry.settings?.map((field) => field.id === 'blockDirectSsh' ? {
      ...field,
      label: translate('settings.blockDirectSsh', {}, locale),
      hint: translate('settings.blockDirectSshHint', {}, locale),
      note: field.note === undefined ? undefined : localizeProviderText(entry.id, field.note, locale),
      confirm: field.confirm ? {
        ...field.confirm,
        off: field.confirm.off ? {
          ...field.confirm.off,
          text: [translate('settings.allowDirectSshConfirm', {}, locale),
            ...(entry.id === 'kimi'
              ? [translate('settings.kimiDirectSshExtraConfirmation', {}, locale)] : []),
          ].join(' '),
          label: translate('settings.allowDirectSsh', {}, locale),
        } : field.confirm.off,
      } : field.confirm,
    } : {
      ...field,
      label: translator.t(locale, `settings.builtinProviders.${entry.id}.settings.${field.id}.label`,
        {}, field.label),
      hint: field.hint === undefined ? undefined
        : translator.t(locale, `settings.builtinProviders.${entry.id}.settings.${field.id}.hint`,
          {}, field.hint),
      note: field.note === undefined ? undefined : localizeProviderText(entry.id, field.note, locale),
    }),
    models: entry.models?.map((model) => ({
      ...model,
      name: translator.t(locale, `settings.builtinProviders.${entry.id}.models.${model.id}`, {}, model.name),
    })),
  };
}

/**
 * Системный манифест переводится по ID плагина, поля и слота, без сопоставления строк.
 * Пользовательские манифесты и все сохраняемые значения остаются исходными данными.
 */
export function localizePluginMetadata(entry: PluginListItem, locale = 'ru'): PluginListItem {
  if (locale === 'ru') {
    return entry;
  }

  const key = `settings.builtinPlugins.${entry.id}`;

  return {
    ...entry,
    name: entry.system ? translator.t(locale, `${key}.name`, {}, entry.name) : entry.name,
    description: entry.system
      ? translator.t(locale, `${key}.description`, {}, entry.description) : entry.description,
    settings: entry.system ? entry.settings.map((field) => ({
      ...field,
      label: translator.t(locale, `${key}.fields.${field.key}.label`, {}, field.label),
      hint: field.hint === undefined ? undefined
        : translator.t(locale, `${key}.fields.${field.key}.hint`, {}, field.hint),
    })) : entry.settings,
    placements: entry.placements?.map((slot) => ({
      ...slot,
      label: translator.t(locale, `settings.pluginSlots.${slot.slot}`, {}, slot.label),
    })),
  };
}

/**
 * Категории принадлежат приложению даже у пользовательского плагина.
 * Проекция меняет только подписи и сохраняет порядок и идентификаторы дерева.
 */
export function localizePluginCategory(category: PluginCategory, locale = 'ru'): PluginCategory {
  return {
    ...category,
    label: translator.t(locale, `settings.pluginCategories.${category.id}.label`, {}, category.label),
    hint: translator.t(locale, `settings.pluginCategories.${category.id}.hint`, {}, category.hint),
  };
}

/**
 * Причины и владельцы native-каталога создаются GrigDesk, а схема CLI хранится отдельно.
 * Пока wire не содержит кода причины, распознаётся только точная собственная подпись
 * зарегистрированной области; неизвестная метаинформация сохраняется исходной строкой.
 */
export function nativeMetadataMessage(
  value: string,
  kind: 'reasons' | 'owners',
  locale: LocaleSource = 'ru',
): UiText {
  const source = messages.ru.settings.nativeMetadata[kind];
  const id = Object.keys(source).find((id) => source[id as keyof typeof source] === value);
  const messageText = localeMessage(locale);

  return id ? messageText(`settings.nativeMetadata.${kind}.${id}`) : value;
}

function nativeCaption(value: string, kind: 'reasons' | 'owners', locale: string): string {
  return resolveLocaleText(nativeMetadataMessage(value, kind, locale), locale);
}

/**
 * Собственные причины и владельцы встроенного источника проецируются в копию дерева.
 * Подписи и документация внешней схемы CLI сохраняются, как и все значения и ревизии.
 */
export function localizeNativeMetadata(
  catalog: ProviderSettingsCatalog,
  locale = 'ru',
): ProviderSettingsCatalog {
  if (locale === 'ru' || !BUILTIN_PROVIDERS.has(catalog.providerId)) {
    return catalog;
  }

  /**
   * Дерево копируется с прежними ID; скрытие и возможность записи не пересчитываются.
   * Причины поддержки consumers принадлежат приложению наравне с запретом записи.
   */
  function fieldView(field: ProviderSettingNode): ProviderSettingNode {
    return {
      ...field,
      reason: field.reason === undefined ? undefined : nativeCaption(field.reason, 'reasons', locale),
      owner: field.owner === undefined ? undefined : nativeCaption(field.owner, 'owners', locale),
      consumerSupport: field.consumerSupport ? Object.fromEntries(
        Object.entries(field.consumerSupport).map(([consumer, support]) => [consumer, {
          ...support,
          reason: support.reason === undefined ? undefined : nativeCaption(support.reason, 'reasons', locale),
        }]),
      ) : undefined,
      children: field.children?.map(fieldView),
      items: field.items ? fieldView(field.items) : undefined,
    };
  }

  return {
    ...catalog,
    scope: {
      ...catalog.scope,
      label: translator.t(locale, `settings.nativeScopes.${catalog.scope.id}`, {}, catalog.scope.label),
    },
    fields: catalog.fields.map(fieldView),
    inactiveOverrides: catalog.inactiveOverrides.map((field) => ({
      ...field,
      reason: nativeCaption(field.reason, 'reasons', locale),
    })),
  };
}
