import { localeMessage, localeTranslator, type LocaleSource } from '../../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../../shared/i18n/catalogs.ts';
import type { ApiClient } from '../../../shared/apiClient.ts';
import { isPlainRecord } from '../../../../../shared/lib/objects.ts';
import type { FieldIntent, JsonValue, ResourceAdapter } from '../contracts.ts';

const BOOLEANS = ['gitRefreshBeforeRun', 'showAllModels', 'chatLiveSessions', 'chatAutoContinue'];
const NUMBERS = ['chatAutoCompactWindow', 'stageAutoCompactWindow', 'runSilenceWindow'];
const ARBITER_KEYS = ['arbiterAuto', 'arbiterModelRef', 'arbiterEffort'];

/**
 * Ответ разбирается по белому списку ресурса и переводится в единицы формы.
 * Дробные минуты сохраняют исходные секунды без округления нетронутого поля.
 */
export function preferencesValues(payload: unknown, defaults = false,
  locale: LocaleSource = 'ru',
): Record<string, JsonValue> {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  if (!isPlainRecord(payload)) {
    throw new TypeError(t("settings.invalidApplicationSettingsResponse"));
  }

  const values: Record<string, JsonValue> = {};

  for (const key of BOOLEANS) {
    if (typeof payload[key] === 'boolean') {
      values[key] = payload[key];
    } else if (defaults) {
      values[key] = key === 'chatLiveSessions' || key === 'chatAutoContinue';
    }
  }

  for (const key of NUMBERS) {
    if (typeof payload[key] === 'number' && Number.isFinite(payload[key])) {
      values[key] = key === 'runSilenceWindow' ? payload[key] / 60 : payload[key];
    } else if (defaults) {
      values[key] = 0;
    }
  }

  const arbiter = isPlainRecord(payload.arbiter) ? payload.arbiter : defaults ? {} : null;

  if (arbiter) {
    const reference = isPlainRecord(arbiter.modelRef) ? arbiter.modelRef : null;

    values.arbiterAuto = arbiter.auto === true;
    values.arbiterEffort = typeof arbiter.effort === 'string' ? arbiter.effort : '';
    values.arbiterModelRef = reference
      && typeof reference.provider === 'string' && typeof reference.model === 'string'
      ? { provider: reference.provider, model: reference.model } : null;
  }

  return values;
}

/**
 * Patch содержит только разрешённые prefs; весь ответ GET обратно не отправляется.
 * Сервер нормализует arbiter целиком, поэтому его три поля дополняются baseline.
 */
function preferencesPatch(
  intents: ReadonlyMap<string, FieldIntent>,
  baseline: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  const patch: Record<string, JsonValue> = {};

  for (const [key, intent] of intents) {
    if (intent.op === 'set' && [...BOOLEANS, ...NUMBERS].includes(key)) {
      patch[key] = key === 'runSilenceWindow' ? Math.round(Number(intent.value) * 60) : intent.value;
    }
  }

  if (ARBITER_KEYS.some((key) => intents.has(key))) {
    const values = { ...baseline };

    for (const key of ARBITER_KEYS) {
      const intent = intents.get(key);

      if (intent?.op === 'set') {
        values[key] = intent.value;
      }
    }

    patch.arbiter = {
      auto: values.arbiterAuto === true,
      modelRef: values.arbiterModelRef ?? null,
      effort: values.arbiterEffort ?? '',
    };
  }

  return patch;
}

/**
 * Серверные предпочтения сохраняются одним patch после общей валидации.
 * Подтверждённый ответ сразу обновляет работающие доменные stores в этом документе.
 */
export function createPreferencesAdapter(
  client: Pick<ApiClient, 'get' | 'post'>,
  onSaved: (values: Record<string, JsonValue>) => void = () => {},
  locale: LocaleSource = 'ru',

): ResourceAdapter {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  return {
    id: 'prefs',
    chain: 'prefs',
    order: 0,
    body: 'patch',
    supportsUnset: false,
    read: async (signal) => preferencesValues(
      await client.get('/api/settings/prefs', { signal }), true, locale,
    ),
    validate: (intents) => [...intents].flatMap(([key, intent]) => {
      if (intent.op !== 'set') {
        return [{ key, message: messageText("settings.removingThisSettingIsUnavailable") }];
      }

      if (NUMBERS.includes(key) && (typeof intent.value !== 'number'
          || !Number.isFinite(intent.value) || intent.value < 0
          || key !== 'runSilenceWindow' && !Number.isInteger(intent.value))) {
        return [{ key, message: messageText("settings.enterANonnegativeNumberInTheSpecified") }];
      }

      if ([...BOOLEANS, 'arbiterAuto'].includes(key) && typeof intent.value !== 'boolean') {
        return [{ key, message: messageText("settings.selectEnabledOrDisabled") }];
      }

      return [];
    }),
    async write(intents, baseline, signal) {
      const values = preferencesValues(await client.post('/api/settings/prefs',
        preferencesPatch(intents, baseline), { signal }), undefined, locale);

      onSaved(values);

      return {
        status: 'success',
        fields: [...intents.keys()].map((key) => ({
          key,
          status: 'success',
          ...Object.hasOwn(values, key) ? { serverValue: values[key] } : {},
        })),
      };
    },
  };
}
