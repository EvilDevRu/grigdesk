import {
  localeMessage, localeTranslator, messages, translator, type LocaleSource,
} from '../../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../../shared/i18n/catalogs.ts';
import { isPlainRecord } from '../../../../../shared/lib/objects.ts';
import type { ApiClient } from '../../../shared/apiClient.ts';
import type { JsonValue, ResourceAdapter } from '../contracts.ts';

export const SPEECH_DEFAULTS: Record<string, JsonValue> = {
  engine: 'browser',
  browserProcessing: 'auto',
  language: 'auto',
  dictionary: '',
  quality: 'balanced',
  videoQuality: 'balanced',
  videoInitialPrompt: '',
  model: null,
  videoModel: null,
  device: 'auto',
  computeType: null,
  beamSize: null,
  vadSilenceMs: 500,
  conditionOnPreviousText: true,
};

export const SPEECH_MODELS = ['small', 'medium', 'large-v3', 'large-v3-turbo'];
export const SPEECH_QUALITIES = ['fast', 'balanced', 'accurate'];
export const QUALITY_MODELS: Record<string, string> = {
  fast: 'small',
  balanced: 'medium',
  accurate: 'large-v3-turbo',
};
export const GRIGDESK_DICTIONARY = [
  'GrigDesk', 'конвейер', 'worktree', 'песочница', 'ворота', 'Битрикс24',
  'Fastify', 'Pinia', 'SSE', 'Codex', 'Kimi',
].join('\n');

/**
 * Названия собственных проверок получают язык UI отдельно от результата диагностики.
 * Пути, неизвестные проверки и серверные fix/reason остаются исходными данными.
 */
export function speechCheckName(name: string, locale: LocaleSource = 'ru'): string {
  const id = typeof locale === 'string' ? locale : locale.value;
  const key = Object.entries(messages.ru.settings.speechChecks)
    .find(([, original]) => original === name)?.[0];

  if (key) {
    return translator.t(id, `settings.speechChecks.${key}`, {}, name);
  }

  const modelId = SPEECH_MODELS.find((modelId) => name === t('settings.speechCheckModel', { modelId }));

  return modelId ? translator.t(id, 'settings.speechCheckModel', { modelId }) : name;
}

export interface SpeechModel {
  modelId: string;
  repo: string;
  cached: boolean;
  sizeMb: number;
}

export interface SpeechCapabilities {
  local: {
    ready: boolean;
    reason: string;
    checks: Array<{
      name: string;
      ok: boolean;
      fix: string;
    }>;
  };
  models: SpeechModel[];
  cuda: { state: string; reason: string };
  languages: string[];
  benchmark: { available: boolean; reason: string };
  lastDictionaryMeasure: { hotwordsTokens: number; hotwordsTruncated: boolean } | null;
}

export interface SpeechSnapshot {
  values: Record<string, JsonValue>;
  revision: string;
  browserAutoConsent: boolean;
  capabilities: SpeechCapabilities;
}

const EMPTY_CAPABILITIES: SpeechCapabilities = {
  local: {
    ready: false,
    reason: '',
    checks: [],
  },
  models: [],
  cuda: { state: 'probe_failed', reason: '' },
  languages: ['ru', 'en', 'auto'],
  benchmark: { available: true, reason: '' },
  lastDictionaryMeasure: null,
};

/**
 * Все поля формы проверяются до общей очереди записи, включая скрытые страницы.
 * null означает доменный дефолт только у явно nullable-параметров речи.
 */
function validSpeechValue(key: string, value: unknown, snapshot = false): value is JsonValue {
  const enums: Record<string, readonly unknown[]> = {
    engine: ['browser', 'whisper'],
    browserProcessing: ['auto', 'local'],
    language: ['auto', 'ru', 'en'],
    quality: SPEECH_QUALITIES,
    videoQuality: SPEECH_QUALITIES,
    model: [null, ...SPEECH_MODELS],
    videoModel: [null, ...SPEECH_MODELS],
    device: ['auto', 'cpu', 'cuda'],
    computeType: [null, 'int8', 'int8_float16', 'float16', 'float32'],
  };

  if (enums[key]) {
    return enums[key].includes(value);
  }
  if (key === 'dictionary' || key === 'videoInitialPrompt') {
    return key === 'videoInitialPrompt' && !snapshot && value === null
      || typeof value === 'string' && value.length <= (key === 'dictionary' ? 800 : 600);
  }
  if (key === 'conditionOnPreviousText') {
    return typeof value === 'boolean';
  }
  if (key === 'beamSize' && value === null) {
    return true;
  }

  return typeof value === 'number' && Number.isInteger(value)
    && (key === 'beamSize' ? value >= 1 && value <= 10
      : key === 'vadSilenceMs' && value >= 100 && value <= 5000);
}

/**
 * Возможности не смешиваются с редактируемыми значениями и дополняют частичные ответы.
 * Из публичного DTO берутся только используемые интерфейсом поля состояния.
 */
function capabilities(value: unknown, previous: SpeechCapabilities): SpeechCapabilities {
  const raw = isPlainRecord(value) ? value : {};
  const local = isPlainRecord(raw.local) ? raw.local : previous.local;
  const cuda = isPlainRecord(raw.cuda) ? raw.cuda : previous.cuda;
  const benchmark = isPlainRecord(raw.benchmark) ? raw.benchmark : previous.benchmark;
  const measure = isPlainRecord(raw.lastDictionaryMeasure) ? raw.lastDictionaryMeasure : null;

  return {
    local: {
      ready: local.ready === true,
      reason: typeof local.reason === 'string' ? local.reason : '',
      checks: Array.isArray(local.checks) ? local.checks.filter(isPlainRecord).map((check) => ({
        name: String(check.name ?? check.id ?? ''),
        ok: check.ok === true,
        fix: typeof check.fix === 'string' ? check.fix : '',
      })) : [],
    },
    models: Array.isArray(raw.models) ? raw.models.filter(isPlainRecord)
      .filter((model) => typeof model.modelId === 'string').map((model) => ({
        modelId: String(model.modelId),
        repo: typeof model.repo === 'string' ? model.repo : '',
        cached: model.cached === true,
        sizeMb: Number.isFinite(Number(model.sizeMb)) ? Number(model.sizeMb) : 0,
      })) : previous.models,
    cuda: {
      state: typeof cuda.state === 'string' ? cuda.state : 'probe_failed',
      reason: typeof cuda.reason === 'string' ? cuda.reason : '',
    },
    languages: Array.isArray(raw.languages) ? raw.languages.filter((item) => typeof item === 'string')
      : previous.languages,
    benchmark: {
      available: benchmark.available !== false,
      reason: typeof benchmark.reason === 'string' ? benchmark.reason : '',
    },
    lastDictionaryMeasure: measure ? {
      hotwordsTokens: Number(measure.hotwordsTokens) || 0,
      hotwordsTruncated: measure.hotwordsTruncated === true,
    } : previous.lastDictionaryMeasure,
  };
}

/**
 * Ресурс сохраняет прежний epoch/revision-контракт, а черновик принадлежит сессии.
 * Внешний снимок сильнее старого GET/POST; opaque revision сравнивается только на равенство.
 */
export function createSpeechResource(
  client: Pick<ApiClient, 'get' | 'post'>,
  onSnapshot: (snapshot: SpeechSnapshot) => void = () => {},
  locale: LocaleSource = 'ru',

) {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  let current: SpeechSnapshot = {
    values: structuredClone(SPEECH_DEFAULTS),
    revision: '',
    browserAutoConsent: false,
    capabilities: structuredClone(EMPTY_CAPABILITIES),
  };
  let epoch = 0;
  let disposed = false;
  let pending: Promise<SpeechSnapshot | null> | null = null;

  /**
   * Частичный снимок дополняет только серверные значения, не значения черновика.
   * Валидные явно возвращённые поля отдельно отмечаются для подтверждения записи.
   */
  function decode(payload: unknown) {
    if (!isPlainRecord(payload)) {
      throw new TypeError(t("settings.invalidSpeechSnapshot"));
    }

    const raw = isPlainRecord(payload.settings) ? payload.settings
      : isPlainRecord(payload.speech) ? payload.speech : payload;
    const values = { ...current.values };
    const present = new Set<string>();

    for (const key of Object.keys(SPEECH_DEFAULTS)) {
      if (Object.hasOwn(raw, key) && validSpeechValue(key, raw[key], true)) {
        values[key] = raw[key];
        present.add(key);
      }
    }

    const revision = raw.revision ?? payload.revision;
    const state = capabilities(payload.capabilities ?? raw.capabilities, current.capabilities);

    if (isPlainRecord(raw.local)) {
      state.local.ready = raw.local.ready === true;
      state.local.reason = typeof raw.local.reason === 'string' ? raw.local.reason : '';
    }

    return {
      snapshot: {
        values,
        revision: typeof revision === 'string' && revision ? revision : current.revision,
        browserAutoConsent: typeof raw.browserAutoConsent === 'boolean'
          ? raw.browserAutoConsent : current.browserAutoConsent,
        capabilities: state,
      },
      present,
    };
  }

  /**
   * Epoch меняется только при изменении настроек, revision и локальной готовности.
   * Изменение кэша модели само по себе не делает уже начатую запись устаревшей.
   */
  function commit(snapshot: SpeechSnapshot): SpeechSnapshot {
    if (disposed) {
      return structuredClone(current);
    }

    if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
      if (JSON.stringify(current.values) !== JSON.stringify(snapshot.values)
          || current.revision !== snapshot.revision
          || current.browserAutoConsent !== snapshot.browserAutoConsent
          || current.capabilities.local.ready !== snapshot.capabilities.local.ready
          || current.capabilities.local.reason !== snapshot.capabilities.local.reason) {
        epoch += 1;
      }

      current = snapshot;
      onSnapshot(structuredClone(current));
    }

    return structuredClone(current);
  }

  function accept(payload: unknown): SpeechSnapshot | null {
    return disposed ? null : commit(decode(payload).snapshot);
  }

  /**
   * Начатое чтение не перетирает снимок, принятый за время ожидания сети.
   * Повторный resync hello разделяет уже выполняющееся чтение этого ресурса.
   */
  async function refresh(signal?: AbortSignal, force = false): Promise<SpeechSnapshot | null> {
    if (pending && !force) {
      return pending;
    }

    const context = { epoch, revision: current.revision };
    const reading = client.get(`/api/settings/speech${force ? '?refresh=1' : ''}`, { signal }).then((raw) => {
      const next = decode(raw).snapshot;

      if (disposed || (epoch !== context.epoch && next.revision !== current.revision)) {
        return null;
      }

      return commit(next);
    });

    pending = reading;

    try {
      return await reading;
    } finally {
      if (pending === reading) {
        pending = null;
      }
    }
  }

  const adapter: ResourceAdapter = {
    id: 'speech',
    chain: 'speech',
    order: 10,
    body: 'patch',
    supportsUnset: false,
    read: async (signal) => (await refresh(signal) ?? current).values,
    validate: (intents) => [...intents].flatMap(([key, intent]) =>
      intent.op !== 'set' || !Object.hasOwn(SPEECH_DEFAULTS, key) || !validSpeechValue(key, intent.value)
        ? [{ key, message: messageText("settings.checkTheValueAndAllowedRangeOf") }] : []),
    /**
     * Patch строится только из изменённых редактируемых полей, без capabilities и consent.
     * Старый ответ записи после внешнего снимка оставляет ввод и требует разрешить конфликт.
     */
    async write(intents, _baseline, signal) {
      const context = { epoch, revision: current.revision };
      const patch = Object.fromEntries([...intents].filter(([key, intent]) =>
        Object.hasOwn(SPEECH_DEFAULTS, key) && intent.op === 'set').map(([key, intent]) =>
        [key, intent.op === 'set' ? intent.value : null]));
      const decoded = decode(await client.post('/api/settings/speech', patch, { signal }));

      if (epoch !== context.epoch && decoded.snapshot.revision !== current.revision) {
        return {
          status: 'conflict',
          message: messageText("settings.speechSettingsChangedExternallyCheckUnappliedFields"),
          fields: [...intents.keys()].map((key) => ({ key, status: 'conflict' })),
        };
      }

      const saved = commit(decoded.snapshot);

      return {
        status: 'success',
        fields: [...intents.keys()].map((key) => ({
          key,
          status: 'success',
          ...decoded.present.has(key) ? { serverValue: saved.values[key] } : {},
        })),
      };
    },
  };

  return {
    adapter,
    accept,
    refresh,
    getSnapshot: () => structuredClone(current),
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}
