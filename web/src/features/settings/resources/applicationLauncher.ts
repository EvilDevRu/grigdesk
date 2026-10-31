import type { ApplicationLauncherState } from '../../../../../shared/desktop/applicationLauncher.ts';
import { localeTranslator, type LocaleSource } from '../../../../../shared/i18n/catalogs.ts';
import { shellAction } from '../../../shared/shellClient.ts';
import type { ResourceAdapter } from '../contracts.ts';

/**
 * Только полный native-ответ подтверждает сохранение настройки приложения.
 * Некорректный ответ не очищает черновик и не изображает успешную запись.
 */
export function decodeApplicationLauncher(raw: unknown, locale: LocaleSource): ApplicationLauncherState {
  const value = raw as ApplicationLauncherState | null;

  if (!value || typeof value.executablePath !== 'string' || !value.executablePath
    || typeof value.autostart !== 'boolean' || typeof value.shortcut?.desktop !== 'boolean'
    || typeof value.shortcut.menu !== 'boolean') {
    throw new TypeError(localeTranslator(locale)('settings.applicationLauncherInvalidResponse'));
  }

  return value;
}

/**
 * Автозапуск окна входит в общий Apply, но пишет исключительно в локальную оболочку.
 * Выбранный удалённый сервер и его API не участвуют в чтении и сохранении этого ресурса.
 */
export function createApplicationLauncherResource(locale: LocaleSource) {
  let view: ApplicationLauncherState | null = null;
  const adapter: ResourceAdapter = {
    id: 'applicationAutostart',
    chain: 'applicationLauncher',
    order: 6900,
    body: 'patch',
    supportsUnset: false,
    async read(signal) {
      view = decodeApplicationLauncher(await shellAction('GET', '/launcher', undefined, signal), locale);

      return { enabled: view.autostart };
    },
    validate: () => [],
    /**
     * ACK возвращает фактическое состояние файла автозапуска после записи.
     * Снимок ярлыка обновляется одновременно, не меняя его отдельной немедленной операции.
     */
    async write(intents, _baseline, signal) {
      const intent = intents.get('enabled');
      const autostart = intent?.op === 'set' && intent.value === true;

      view = decodeApplicationLauncher(await shellAction('POST', '/launcher', { autostart }, signal), locale);

      return {
        status: 'success',
        fields: [{
          key: 'enabled',
          status: 'success',
          serverValue: view.autostart,
        }],
      };
    },
  };

  return {
    adapter,
    view: () => view,
    accept(state: ApplicationLauncherState) {
      view = state;
    },
  };
}
