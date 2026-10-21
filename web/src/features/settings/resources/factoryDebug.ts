import { localeMessage, localeTranslator, type LocaleSource } from '../../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../../shared/i18n/catalogs.ts';
import { isPlainRecord } from '../../../../../shared/lib/objects.ts';
import { diagnosticLevel, type DiagnosticLevel } from '../../../../../shared/web-log/diagnosticLogging.ts';
import type { ApiClient } from '../../../shared/apiClient.ts';
import type { ResourceAdapter } from '../contracts.ts';

export interface DiagnosticView {
  level: DiagnosticLevel;
  effective: DiagnosticLevel;
  source: string;
  expiresAt: number;
}

/**
 * Настроенный уровень и действующий уровень различаются при внешнем переопределении.
 * Некорректное подтверждение не выдаётся за сохранённый выбор человека.
 */
function diagnosticView(payload: unknown,
  locale: LocaleSource = 'ru',
): DiagnosticView {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  if (!isPlainRecord(payload)) {
    throw new TypeError(t("settings.invalidDiagnosticsResponse"));
  }

  const effective = diagnosticLevel(payload.effective);
  const level = payload.configured === 'inherit' ? effective : diagnosticLevel(payload.configured);

  if (!effective || !level || typeof payload.source !== 'string'
      || typeof payload.expiresAt !== 'number') {
    throw new TypeError(t("settings.invalidDiagnosticsResponse"));
  }

  return {
    level,
    effective,
    source: payload.source,
    expiresAt: payload.expiresAt,
  };
}

/**
 * Политика меняется только по подтверждённому ответу, форма не вызывает applyPolicy сама.
 * Более поздняя запись или чтение исключает устаревший снимок диагностики.
 */
export function createFactoryDebugAdapter(
  client: Pick<ApiClient, 'get' | 'post'>,
  onView: (view: DiagnosticView) => void,
  locale: LocaleSource = 'ru',

): ResourceAdapter {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  let version = 0;

  return {
    id: 'factoryDebug',
    chain: 'factoryDebug',
    order: 6000,
    body: 'patch',
    supportsUnset: false,
    /**
     * Устаревшее чтение не обгоняет последующую запись или свежий снимок.
     * Только разобранное состояние передаётся в работающий журнал окна.
     */
    async read(signal) {
      const request = ++version;
      const payload = await client.get('/api/settings/factory-debug?scope=global', { signal });
      const view = diagnosticView(payload, locale);

      if (version !== request) {
        throw new DOMException(t("settings.staleDiagnosticsRead"), 'AbortError');
      }

      onView(view);

      return { level: view.level };
    },
    validate: (intents) => {
      const intent = intents.get('level');

      return intent?.op === 'set' && diagnosticLevel(intent.value) === null
        ? [{ key: 'level', message: messageText("settings.unknownDiagnosticLevel") }] : [];
    },
    /**
     * Тело записи содержит только выбранный уровень и явную глобальную область.
     * Подтверждение использует configured, а runtime получает effective.
     */
    async write(intents, _baseline, signal) {
      const intent = intents.get('level');

      version += 1;

      const view = diagnosticView(await client.post('/api/settings/factory-debug', {
        scope: 'global',
        level: intent?.op === 'set' ? intent.value : 'off',
      }, { signal }), locale);

      onView(view);

      return {
        status: 'success',
        fields: [{
          key: 'level',
          status: 'success',
          serverValue: view.level,
        }],
      };
    },
  };
}
