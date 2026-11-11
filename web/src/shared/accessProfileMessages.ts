import type { MessageKey } from '../../../shared/i18n/catalogs.ts';

const messages: Readonly<Record<string, MessageKey>> = {
  invalid_key: 'settings.accessProfilesInvalidInput',
  invalid_input: 'settings.accessProfilesInvalidInput',
  auth_required: 'settings.accessProfilesAccessRejected',
  access_auth_required: 'settings.accessProfilesAccessRejected',
  unavailable: 'settings.accessProfilesNetworkUnavailable',
  rate_limited: 'settings.accessProfilesRateLimited',
  limited: 'settings.accessProfilesQuotaUnavailable',
  quota_exceeded: 'settings.accessProfilesQuotaUnavailable',
  unsupported: 'settings.accessProfilesUnsupported',
  unsupported_method: 'settings.accessProfilesUnsupported',
  expired: 'settings.accessProfilesExpired',
  interrupted: 'settings.accessProfilesInterrupted',
  stale_revision: 'settings.accessProfilesChanged',
  stale_step: 'settings.accessProfilesChanged',
  access_busy: 'settings.accessProfilesBusy',
  save_failed: 'settings.accessProfilesSaveFailed',
  EIO: 'settings.accessProfilesSaveFailed',
};

/**
 * Закрытый код причины выбирает собственное RU/EN объяснение мастера.
 * Сырой ответ поставщика или вывод CLI не попадает в перевод и интерфейс.
 */
export function accessProfileErrorKey(code: string): MessageKey {
  return Object.hasOwn(messages, code) ? messages[code]! : 'settings.accessProfilesFailed';
}
