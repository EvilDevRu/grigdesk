import { localeMessage, localeTranslator, type LocaleSource } from '../../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../../shared/i18n/catalogs.ts';
import type { ApiClient } from '../../../shared/apiClient.ts';
import type { B24CredsView } from '../../../../../shared/b24/credentialsContracts.ts';
import type { ResourceAdapter, JsonValue } from '../contracts.ts';

/**
 * Публичный снимок Б24 никогда не превращает маску пароля в содержимое поля.
 * Явная проверка пары строк нужна и для первого чтения, и для подтверждения POST.
 */
function decodeB24(raw: unknown,
  locale: LocaleSource = 'ru',
): B24CredsView {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  const value = raw as Partial<B24CredsView> | null;

  if (!value || typeof value.baseUrl !== 'string' || typeof value.login !== 'string'
      || typeof value.configured !== 'boolean') {
    throw new TypeError(t("settings.bConnectionSnapshotNotReceived"));
  }

  return {
    configured: value.configured,
    baseUrl: value.baseUrl,
    login: value.login,
  };
}

/**
 * Б24 заменяет запись целиком и требует новый пароль при любом изменении.
 * Неизменённый baseUrl сохраняется из baseline, секрет берётся только из intent.
 */
export function createB24Adapter(
  client: Pick<ApiClient, 'get' | 'post'>,
  onView: (view: B24CredsView) => void,
  locale: LocaleSource = 'ru',

): ResourceAdapter {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  return {
    id: 'b24',
    chain: 'b24',
    order: 20,
    body: 'full-record',
    supportsUnset: false,
    async read(signal) {
      const view = decodeB24(await client.get('/api/settings/b24', { signal }), locale);

      onView(view);

      return { baseUrl: view.baseUrl, login: view.login };
    },
    /**
     * Полный POST требует нового секрета независимо от прежнего configured.
     * Ошибка адресуется полю пароля до запуска общей очереди записей.
     */
    validate(intents, baseline) {
      const values = { ...baseline };

      for (const [key, intent] of intents) {
        if (intent.op === 'set') {
          values[key] = intent.value;
        }
      }

      return ['baseUrl', 'login', 'password'].flatMap((key) =>
        typeof values[key] === 'string' && values[key].trim()
          ? [] : [{
            key,
            message: key === 'password'
              ? messageText("settings.enterANewPasswordToSaveThe") : messageText("settings.fillInThisField"),
          }]);
    },
    /**
     * Публичный ответ подтверждает только несекретные поля и наличие подключения.
     * Пароль очищается по ACK, не возвращаясь в baseline или результат.
     */
    async write(intents, baseline, signal) {
      const values: Record<string, JsonValue> = { ...baseline };

      for (const [key, intent] of intents) {
        if (intent.op === 'set') {
          values[key] = intent.value;
        }
      }

      const view = decodeB24(await client.post('/api/settings/b24', {
        baseUrl: values.baseUrl,
        login: values.login,
        password: values.password,
      }, { signal }), locale);

      if (!view.configured) {
        return {
          status: 'unknown',
          fields: [],
          message: messageText("settings.connectionNotConfirmedByTheServer"),
        };
      }

      onView(view);

      return {
        status: 'success',
        fields: [...intents].map(([key]) => ({
          key,
          status: 'success',
          ...key === 'baseUrl' || key === 'login' ? { serverValue: view[key] } : {},
        })),
      };
    },
  };
}
