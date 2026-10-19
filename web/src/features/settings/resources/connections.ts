import type { ApiClient } from '../../../shared/apiClient.ts';
import type { B24CredsView } from '../../../../../shared/b24/credentialsContracts.ts';
import type { ResourceAdapter, JsonValue } from '../contracts.ts';

/**
 * Публичный снимок Б24 никогда не превращает маску пароля в содержимое поля.
 * Явная проверка пары строк нужна и для первого чтения, и для подтверждения POST.
 */
function decodeB24(raw: unknown): B24CredsView {
  const value = raw as Partial<B24CredsView> | null;

  if (!value || typeof value.baseUrl !== 'string' || typeof value.login !== 'string'
      || typeof value.configured !== 'boolean') {
    throw new TypeError('Не получен снимок подключения Б24');
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
): ResourceAdapter {
  return {
    id: 'b24',
    chain: 'b24',
    order: 20,
    body: 'full-record',
    supportsUnset: false,
    async read(signal) {
      const view = decodeB24(await client.get('/api/settings/b24', { signal }));

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
            message: key === 'password' ? 'Введите новый пароль для записи подключения' : 'Заполните поле',
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
      }, { signal }));

      if (!view.configured) {
        return {
          status: 'unknown',
          fields: [],
          message: 'Подключение не подтверждено сервером',
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
