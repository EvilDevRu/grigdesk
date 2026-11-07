import { localeMessage, localeTranslator, type LocaleSource } from '../../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../../shared/i18n/catalogs.ts';
import type { ApiClient } from '../../../shared/apiClient.ts';
import type { LauncherState, AutostartState } from '../../../../../shared/runtime/launcherContracts.ts';
import type { ResourceAdapter } from '../contracts.ts';

/**
 * Состояние юнита не смешивается с режимом живого процесса приложения.
 * Некорректный ACK не подтверждает изменение даже при успешном HTTP.
 */
function decodeAutostart(raw: unknown,
  locale: LocaleSource = 'ru',
): AutostartState {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  const value = raw as AutostartState | null;

  if (!value || !['enabled', 'disabled', 'missing'].includes(value.unit)
      || !['boot', 'login', 'off', 'unavailable'].includes(value.mode)
      || typeof value.active !== 'boolean' || value.linger !== null && typeof value.linger !== 'boolean') {
    throw new TypeError(t("settings.autostartStatusNotReceived"));
  }

  return { ...value };
}

/**
 * Адаптер хранит переключатель в сессии, а подсказки получает из подтверждённого снимка.
 * Ярлык остаётся отдельной немедленной операцией и не попадает в Apply.
 */
export function createAutostartResource(client: Pick<ApiClient, 'get' | 'put'>,
  locale: LocaleSource = 'ru',
) {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  let view: LauncherState | null = null;
  const adapter: ResourceAdapter = {
    id: 'autostart',
    chain: 'autostart',
    order: 7000,
    body: 'patch',
    supportsUnset: false,
    async read(signal) {
      const reply = await client.get('/api/system/launcher', { signal }) as LauncherState;

      view = { autostart: decodeAutostart(reply?.autostart, locale), shortcut: reply.shortcut };

      return { enabled: view.autostart.unit === 'enabled' };
    },
    validate(intents) {
      const intent = intents.get('enabled');

      return view?.autostart.unit !== 'missing' && intent?.op === 'set' && typeof intent.value === 'boolean'
        ? [] : [{ key: 'enabled', message: messageText("settings.autostartIsCurrentlyUnavailable") }];
    },
    /**
     * Сохранение подтверждается фактическим состоянием юнита в ответе.
     * Структура ответа проверяется до очистки intent автозапуска.
     */
    async write(intents, _baseline, _signal) {
      const intent = intents.get('enabled');
      const reply = await client.put('/api/system/launcher/autostart', {
        enabled: intent?.op === 'set' ? intent.value : false,
      }) as { autostart: AutostartState };
      const autostart = decodeAutostart(reply?.autostart, locale);

      view = { ...view!, autostart };

      return {
        status: 'success',
        fields: [{
          key: 'enabled',
          status: 'success',
          serverValue: autostart.unit === 'enabled',
        }],
      };
    },
  };

  return { adapter, view: () => view };
}
