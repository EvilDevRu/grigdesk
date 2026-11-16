import {
  localeTranslator, messages, translator, type LocaleSource,
} from '../../../../shared/i18n/catalogs.ts';
import type { ProviderEntry } from '../../../../shared/chat/providersContracts.ts';
import { normalizeExecutorType } from '../../../../shared/chat/executorTypes.ts';

export interface ProviderAvailabilityView {
  available: boolean;
  label: string;
}

export interface ProviderChatReadiness extends ProviderAvailabilityView {
  message: string;
}

interface ProviderAction {
  kind: string;
  label: string;
  command?: string;
}

/**
 * Общая подпись описывает доступность сервиса независимо от поддержки чата.
 * Проекция читает готовый снимок и не запускает дополнительные проверки.
 */
export function providerAvailability(
  provider: Pick<ProviderEntry, 'available'>,
  locale: LocaleSource = 'ru',
): ProviderAvailabilityView {
  const available = provider.available === true;
  const t = localeTranslator(locale);

  return {
    available,
    label: available ? t('settings.available') : t('settings.unavailable2'),
  };
}

/**
 * Готовность чата требует моделей сверх наличия CLI и локального доступа.
 * Узкие и setup-only исполнители сохраняют собственный статус подключения.
 */
export function providerChatReadiness(
  provider: ProviderEntry,
  locale: LocaleSource = 'ru',
): ProviderChatReadiness | null {
  if (normalizeExecutorType(provider.type) !== 'universal' || provider.chatEnabled === false) {
    return null;
  }

  const t = localeTranslator(locale);

  if (provider.installed === false && provider.kind !== 'api') {
    return {
      available: false,
      label: t('settings.providerChatNotInstalled'),
      message: t('settings.providerChatInstallHint'),
    };
  }

  if (provider.available !== true) {
    return {
      available: false,
      label: t('settings.setupRequired'),
      message: provider.authLabel || t('settings.providerChatAccessHint'),
    };
  }

  if (!provider.models?.length) {
    return {
      available: false,
      label: t('settings.providerChatNoModels'),
      message: t('settings.providerChatNoModelsHint'),
    };
  }

  return { ...providerAvailability(provider, locale), message: '' };
}

/**
 * Только известная собственная подпись доступа переводится внутри ID исполнителя.
 * Неизвестный статус сервера остаётся исходным; публичный DTO не меняется.
 */
export function localizeProviderAuthLabel(
  provider: Pick<ProviderEntry, 'id' | 'authLabel'>,
  locale: LocaleSource = 'ru',
): string {
  const original = provider.authLabel ?? '';
  const id = typeof locale === 'string' ? locale : locale.value;

  if (id === 'ru') {
    return original;
  }

  const metadata = messages.ru.settings.builtinProviders[
    provider.id as keyof typeof messages.ru.settings.builtinProviders
  ];
  const labels = metadata && 'auth' in metadata ? metadata.auth : {};
  const key = Object.entries(labels).find(([, label]) => label === original)?.[0];

  return key ? translator.t(id, `settings.builtinProviders.${provider.id}.auth.${key}`, {}, original)
    : original;
}

/**
 * Собственная команда входа сохраняет payload и меняет только подпись действия.
 * Внешние действия и прямой русский вызов возвращают исходный объект.
 */
export function localizeProviderAction<T extends ProviderAction>(
  providerId: string,
  action: T,
  locale: LocaleSource = 'ru',
): T {
  const id = typeof locale === 'string' ? locale : locale.value;
  const source = messages.ru.core.providerLogin;
  const original = source[providerId as keyof typeof source];

  if (id === 'ru' || !original || action.kind !== 'terminal'
      || action.command !== `${providerId} login` || action.label !== original) {
    return action;
  }

  return { ...action, label: translator.t(id, `core.providerLogin.${providerId}`, {}, original) };
}
