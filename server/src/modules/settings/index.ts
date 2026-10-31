// Модуль settings — редактирование кредов B24 из «Настроек» + проверка авторизации.
// GrigDesk хранит креды у себя (единственный владелец сессии).
// Авторизация Claude настраивается не здесь: чат использует хостовый CLI (claude login),
// статус исполнителей отдаёт реестр /api/providers.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FactoryDebugInputError } from '../../lib/factoryDebug.ts';
import { DiagnosticLoggingPolicy } from '../../lib/diagnosticLogging.ts';
import { ModelJobError } from '../../lib/speech/modelJobs.ts';
import {
  SpeechSettingsConflictError,
  SpeechSettingsInputError,
  SpeechSettingsStore,
} from '../../lib/speechSettings.ts';
import type { ModelJobManager } from '../../lib/speech/modelJobs.ts';
import type { SpeechRuntime } from '../../lib/speech/runtime.ts';
import type { FactoryDebugSettings } from '../../lib/factoryDebug.ts';
import { PrefsCorruptedError, publicPrefsView } from '../../lib/prefsStore.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';

// Кто владеет кредами B24 и умеет проверить вход. Оба соседа ещё JavaScript.
export interface CredsStorePort {
  publicView: () => unknown;
  write: (creds: { login: unknown; password: unknown; baseUrl: unknown }) => unknown;
}

export interface B24Port {
  invalidate: () => unknown;
  testAuth: () => Promise<unknown>;
}

export interface SettingsModuleOptions {
  credsStore: CredsStorePort;
  b24: B24Port;
  prefs: PrefsStore;
  factoryDebug: FactoryDebugSettings;
  diagnosticLogging?: DiagnosticLoggingPolicy;
  speechRuntime?: SpeechRuntime | null;
  speechSettings?: SpeechSettingsStore;
  modelJobs?: ModelJobManager | null;
}

// Снимок настроек речи вместе с возможностями окружения.
interface SpeechSnapshot {
  settings: Record<string, unknown>;
  revision: string;
  capabilities: Record<string, unknown>;
}

// Запросы модуля: параметры адреса, тело и строка запроса — всё недоверенное.
type SettingsRequest = FastifyRequest<{
  Params: { modelId: string; jobId: string };
  Body: Record<string, unknown> | null;
  Querystring: Record<string, unknown>;
}>;

const PROTECTED_PREFS = new Map([
  ['speech', '/api/settings/speech'],
  // Реестры проектов принадлежат разделу «Проекты»: здесь они пишутся только своим API,
  // иначе одна общая запись настроек затирала бы паспорта проектов целиком.
  ['projects', '/api/projects'],
  ['projectsMeta', '/api/projects'],
  ['plugins', '/api/plugins/:id/toggle'],
  ['pluginSettings', '/api/plugins/:id/settings'],
  ['providerSettings', '/api/providers/:id/settings'],
]);

const UNAVAILABLE_SPEECH_CAPABILITIES = Object.freeze({
  local: { ready: false, reason: 'speech_runtime_unavailable', checks: [] },
  models: [],
  cuda: { state: 'probe_failed' },
  languages: ['ru', 'en', 'auto'],
  lastDictionaryMeasure: null,
  resident: {
    supported: false,
    loaded: false,
    model: null,
    device: null,
    memMb: null,
    unloadAtSec: null,
  },
});
const UNAVAILABLE_SPEECH_BENCHMARK = Object.freeze({
  available: false,
  reason: 'Эталонная запись benchmark не настроена оператором.',
});

/**
 * Настройки подключают серверные сервисы через явные зависимости.
 * Учётные данные, диагностика и речь сохраняют собственные контракты записи.
 */
async function settingsModule(
  fastify: FastifyInstance,
  opts: SettingsModuleOptions,
): Promise<void> {
  const {
    credsStore, b24, prefs, factoryDebug, speechRuntime,
  } = opts;
  const diagnosticLogging = opts.diagnosticLogging ?? new DiagnosticLoggingPolicy(factoryDebug);
  const speechSettings = opts.speechSettings || new SpeechSettingsStore({ prefs });
  const modelJobs = Object.hasOwn(opts, 'modelJobs') ? opts.modelJobs : (speechRuntime?.modelJobs || null);
  let speechMutationTail: Promise<unknown> = Promise.resolve();

  function serializeSpeechMutation<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = speechMutationTail.then(operation, operation);
    speechMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function invalidateSpeechCapabilities() {
    if (typeof speechRuntime?.invalidateCapabilities === 'function') {
      return speechRuntime.invalidateCapabilities();
    }
    return speechRuntime?.refreshCapabilities?.();
  }

  async function speechSnapshot(
    current = speechSettings.read(),
    { lightweight = false } = {},
  ): Promise<SpeechSnapshot> {
    let runtimeCapabilities: Record<string, unknown>;
    if (lightweight && (speechRuntime?.publicSnapshot || speechRuntime?.publicSnapshotAsync)) {
      // Сохранение и privacy-consent находятся на критическом пути первого клика по
      // микрофону. Отдаём последний readiness snapshot синхронно: новый probe уже
      // запущен applyRuntimeSettings() в фоне и не задерживает consent/SSE. Async seam
      // оставлен только для совместимых runtime без sync snapshot.
      const publicSpeech = speechRuntime.publicSnapshot
        ? speechRuntime.publicSnapshot(current.settings)
        : await speechRuntime.publicSnapshotAsync(current.settings);
      runtimeCapabilities = {
        local: publicSpeech?.local || UNAVAILABLE_SPEECH_CAPABILITIES.local,
        resident: publicSpeech?.resident || UNAVAILABLE_SPEECH_CAPABILITIES.resident,
      };
    } else {
      // Detached download/copy продолжает работу без открытой вкладки. Подбираем
      // terminal job перед capability probe, иначе старый cached:false жил бы до
      // ручного refresh/save/restart.
      if (modelJobs && modelJobs !== speechRuntime?.modelJobs) {
        await modelJobs?.reconcileCompleted?.();
      }
      runtimeCapabilities = speechRuntime?.capabilities
        ? await speechRuntime.capabilities()
        : UNAVAILABLE_SPEECH_CAPABILITIES;
    }
    const benchmark = modelJobs?.benchmarkStatus?.()
      || runtimeCapabilities?.benchmark
      || UNAVAILABLE_SPEECH_BENCHMARK;
    return {
      ...current,
      capabilities: { ...runtimeCapabilities, benchmark },
    };
  }

  function broadcastSpeech(snapshot: SpeechSnapshot): void {
    fastify.sse?.broadcast?.('speech-settings', snapshot);
  }

  function speechModelJobsUnavailable(reply: FastifyReply): unknown {
    return reply.code(503).send({
      error: 'speech_model_jobs_unavailable',
      message: 'Фоновые задачи моделей речи недоступны.',
    });
  }

  function speechModelJobError(err: unknown, reply: FastifyReply): unknown {
    if (err instanceof ModelJobError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof TypeError) {
      return reply.code(400).send({ error: 'bad_speech_job', message: err.message });
    }
    throw err;
  }

  // Общие настройки GrigDesk (правила запусков и пр.).
  fastify.get('/api/settings/prefs', async () => publicPrefsView(prefs.read()));
  fastify.post('/api/settings/prefs', async (request: SettingsRequest, reply) => {
    const body = request.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({
        error: 'bad_preference',
        message: 'Настройки должны быть JSON-объектом.',
      });
    }
    for (const [key, endpoint] of PROTECTED_PREFS) {
      if (key in body) {
        return reply.code(400).send({
          error: 'protected_preference',
          message: `Настройка ${key} меняется только через ${endpoint}.`,
        });
      }
    }

    try {
      return publicPrefsView(prefs.write(body));
    } catch (err) {
      // Файл настроек не читается — запись отклонена целиком, и человеку нужен не
      // «внутренний сбой», а понятная причина: иначе порча выглядит как сбой GrigDesk.
      if (err instanceof PrefsCorruptedError) {
        return reply.code(500).send({ error: 'prefs_corrupted', message: err.message });
      }
      throw err;
    }
  });

  fastify.get('/api/settings/speech', async (request: SettingsRequest) => {
    if (request.query?.refresh === '1') await invalidateSpeechCapabilities();
    return speechSnapshot();
  });

  fastify.post('/api/settings/speech', async (request: SettingsRequest, reply) => {
    try {
      return await serializeSpeechMutation(async () => {
        // update() целиком синхронен; очередь дополнительно сохраняет порядок async
        // apply/capabilities/SSE, чтобы медленный первый ответ не обогнал второй.
        const current = speechSettings.update(request.body);
        await speechRuntime?.applyRuntimeSettings?.(current.settings);
        const snapshot = await speechSnapshot(current, { lightweight: true });
        broadcastSpeech(snapshot);
        return snapshot;
      });
    } catch (err) {
      if (err instanceof SpeechSettingsInputError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  fastify.post('/api/settings/speech/browser-consent', async (request: SettingsRequest, reply) => {
    try {
      return await serializeSpeechMutation(async () => {
        const previousRevision = speechSettings.read().revision;
        const current = speechSettings.grantBrowserConsent(request.body ?? {});
        const changed = current.revision !== previousRevision;
        if (changed) await speechRuntime?.applyRuntimeSettings?.(current.settings);
        const snapshot = await speechSnapshot(current, { lightweight: true });
        if (changed) broadcastSpeech(snapshot);
        return snapshot;
      });
    } catch (err) {
      if (err instanceof SpeechSettingsConflictError) {
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      if (err instanceof SpeechSettingsInputError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  fastify.post('/api/settings/speech/models/:modelId/download', async (request: SettingsRequest, reply) => {
    if (!modelJobs) return speechModelJobsUnavailable(reply);
    try {
      const started = await modelJobs.startDownload(request.params.modelId);
      return reply.code(202).send(started);
    } catch (err) {
      return speechModelJobError(err, reply);
    }
  });

  fastify.post('/api/settings/speech/models/:modelId/copy', async (request: SettingsRequest, reply) => {
    if (!modelJobs) return speechModelJobsUnavailable(reply);
    try {
      const started = await modelJobs.startCopy(request.params.modelId);
      return reply.code(202).send(started);
    } catch (err) {
      return speechModelJobError(err, reply);
    }
  });

  fastify.post('/api/settings/speech/benchmark', async (request: SettingsRequest, reply) => {
    if (!modelJobs) return speechModelJobsUnavailable(reply);
    try {
      const started = await modelJobs.startBenchmark(request.body || {});
      return reply.code(202).send(started);
    } catch (err) {
      return speechModelJobError(err, reply);
    }
  });

  fastify.get('/api/settings/speech/jobs/:jobId', async (request: SettingsRequest, reply) => {
    if (!modelJobs) return speechModelJobsUnavailable(reply);
    try {
      const job = await modelJobs.readJob(request.params.jobId);
      if (!job) {
        return reply.code(404).send({
          error: 'speech_job_not_found',
          message: 'Задача модели речи не найдена.',
        });
      }
      return job;
    } catch (err) {
      return speechModelJobError(err, reply);
    }
  });

  fastify.delete('/api/settings/speech/jobs/:jobId', async (request: SettingsRequest, reply) => {
    if (!modelJobs) return speechModelJobsUnavailable(reply);
    try {
      const job = await modelJobs.cancelJob(request.params.jobId);
      if (!job) {
        return reply.code(404).send({
          error: 'speech_job_not_found',
          message: 'Задача модели речи не найдена.',
        });
      }
      return job;
    } catch (err) {
      return speechModelJobError(err, reply);
    }
  });

  // Область диагностики приходит из запроса. Приводится только `scope` (у него есть
  // умолчание); профиль и задачу передаём как есть — их отсутствие само по себе значимо,
  // и подмена `undefined` на `null` меняла бы аргументы, которые видит CLI движка.
  const debugTarget = (scope: unknown, profile: unknown, task: unknown) => ({
    scope: String(scope),
    profile: profile as string | number | null | undefined,
    task: task as string | number | null | undefined,
  });

  // Диагностические логи фабрики. Источник истины — engine CLI: сервер не читает и
  // не пишет его settings-файлы сам.
  fastify.get('/api/settings/factory-debug', async (request: SettingsRequest, reply) => {
    const { scope = 'global', profile, task } = request.query || {};
    try {
      const target = debugTarget(scope, profile, task);

      return target.scope === 'global'
        ? await diagnosticLogging.view()
        : await factoryDebug.show(target);
    } catch (err) {
      if (err instanceof FactoryDebugInputError) {
        return reply.code(400).send({ error: 'bad_debug_setting', message: err.message });
      }
      return reply.code(502).send({
        error: 'factory_debug_failed',
        message: (err as Error).message,
      });
    }
  });

  fastify.post('/api/settings/factory-debug', async (request: SettingsRequest, reply) => {
    const {
      scope = 'global', profile, task, level, duration, clear = false,
    } = request.body || {};
    const target = debugTarget(scope, profile, task);
    try {
      const view = target.scope === 'global'
        ? clear
          ? await diagnosticLogging.clear()
          : await diagnosticLogging.set(String(level), duration)
        : clear
          ? await factoryDebug.clear(target)
          : await factoryDebug.set({ ...target, level: String(level), duration });

      if (target.scope === 'global') {
        fastify.sse?.broadcast?.('diagnostic-logging', { at: Date.now() });
      }

      return view;
    } catch (err) {
      if (err instanceof FactoryDebugInputError) {
        return reply.code(400).send({ error: 'bad_debug_setting', message: err.message });
      }
      return reply.code(502).send({
        error: 'factory_debug_failed',
        message: (err as Error).message,
      });
    }
  });

  // Текущие настройки B24 (без пароля).
  fastify.get('/api/settings/b24', async () => credsStore.publicView());

  // Сохранить креды. Мутация (нужен токен, если настроен).
  fastify.post('/api/settings/b24', async (request: SettingsRequest, reply) => {
    const { login, password, baseUrl } = request.body || {};
    if (!login || !password) {
      return reply.code(400).send({ error: 'bad_input', message: 'Укажите логин и пароль.' });
    }

    await credsStore.write({ login, password, baseUrl });
    await b24.invalidate();

    return credsStore.publicView();
  });

  // Проверить авторизацию: логинимся, возвращаем результат.
  fastify.post('/api/settings/b24/test', async () => b24.testAuth());
}

export default fp(settingsModule, { name: 'module-settings' });
