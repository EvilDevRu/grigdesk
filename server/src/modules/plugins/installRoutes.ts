import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Ajv } from 'ajv';
import type { AnySchema } from 'ajv';
import { inputs, outputs } from './installSchemas.ts';
import type { InstallRequest, PluginInstallPort, RollbackRequest } from '../../lib/packageInstall/service.ts';
import { errorInfo, installError, PluginInstallError } from '../../lib/packageInstall/errors.ts';

import type { PluginInstallJob } from '../../../../shared/plugins/pluginInstallContracts.ts';
import { validArchiveKey } from '../../lib/packageInstall/stateValidation.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';

type JobRequest = FastifyRequest<{ Params: { jobId: string }; Body: { reviewToken: string } }>;
type PluginRequest = FastifyRequest<{ Params: { id: string }; Body: RollbackRequest }>;
type UpdateRequest = FastifyRequest<{
  Params: { id: string };
  Body: Omit<InstallRequest, 'url' | 'expectedId'>;
}>;

/**
 * Общие формы job сохраняются, дополнительные поля принадлежат только driver API.
 * Plugin serializer и его публичный контракт не расширяются вместе с драйверами.
 */
function driverOutputSchemas(): typeof outputs {
  const result: unknown = JSON.parse(JSON.stringify(outputs)
    .replaceAll('pluginId', 'driverId').replaceAll('plugins', 'drivers'));

  /**
   * Обходит только данные JSON Schema и расширяет узлы с driverId.
   * Вложенные install records и plugin-схемы сохраняют прежнюю форму.
   */
  function extend(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }

    if (isRecord(value.properties) && Object.hasOwn(value.properties, 'driverId')) {
      value.properties.restartRequired = { type: 'boolean' };

      const preview = value.properties.preview;

      if (isRecord(preview) && isRecord(preview.properties)) {
        preview.properties.payloadDigest = {
          type: 'string',
          nullable: true,
          pattern: '^[a-f0-9]{64}$',
        };
      }
    }

    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        child.forEach(extend);
      } else {
        extend(child);
      }
    }
  }

  extend(result);

  return result as typeof outputs;
}

/**
 * Префиксы роутов установки: их POST-мутации допускают только браузерную сессию.
 * Список передаётся общему auth-гарду в app.ts и тестовым фикстурам.
 */
export const SESSION_ONLY_PREFIXES = ['/api/driver-installs', '/api/plugin-installs'] as const;

/**
 * Установка имеет свой encapsulated HTTP scope и отдельный session допуск.
 * Чтение исхода остаётся доступным всем авторизованным transport ядра.
 */
export default async function installRoutes(
  app: FastifyInstance,
  {
    installs, driver = false, basePath = '/api/plugin-installs', itemSegment = 'plugins',
  }: {
    installs: PluginInstallPort;
    driver?: boolean;
    basePath?: string;
    itemSegment?: string;
  },
): Promise<void> {
  const prefix = driver ? '/api/driver-installs' : basePath;
  const resource = driver ? 'drivers' : itemSegment;
  const responseSchemas = driver ? driverOutputSchemas() : outputs;

  /**
   * Публичный job использует имя своей области, внутренний журнал остаётся общим.
   * Проверка ссылки на архив выполняется до удаления служебного имени поля.
   */
  const jobView = (job: PluginInstallJob | null) => {
    const checked = publicJob(job);

    if (!driver || !checked) {
      return checked;
    }

    const { pluginId, ...fields } = checked;

    return {
      ...fields,
      driverId: pluginId,
      preview: fields.preview ? {
        ...fields.preview,
        payloadDigest: installs.payloadDigest?.(checked.id) ?? null,
      } : null,
      restartRequired: pluginId ? installs.restartRequired(pluginId) : false,
    };
  };
  const validator = new Ajv({
    removeAdditional: false,
    coerceTypes: false,
    allErrors: false,
  });

  app.setValidatorCompiler(({ schema }) => validator.compile(schema as AnySchema));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PluginInstallError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }

    const status = clientErrorStatus(error);

    if (status) {
      return reply.code(status).send({
        error: 'invalid_request',
        message: 'Некорректный запрос установки.',
      });
    }

    const safe = errorInfo(error);

    app.log.error({ code: safe.code }, 'Ошибка API установки плагина');

    return reply.code(500).send({ error: safe.code, message: safe.message });
  });

  // Допуск сессии для POST проверяет общий auth-гард по SESSION_ONLY_PREFIXES:
  // единая фаза onRequest сохраняет приоритет отказа и не зависит от порядка
  // регистрации плагинов. Здесь остаются только Origin и Content-Type.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') {
      return;
    }

    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin).origin;
        const current = new URL(`${request.protocol}://${request.headers.host}`).origin;

        if (origin !== current) {
          throw new Error('origin mismatch');
        }
      } catch {
        return reply.code(403).send({ error: 'origin_forbidden', message: 'Недопустимый Origin запроса.' });
      }
    }

    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return reply.code(415).send({ error: 'unsupported_media_type', message: 'Требуется JSON.' });
    }
  });

  app.get(`${prefix}/jobs/current`, { schema: { response: responseSchemas.current } }, async () => ({
    job: jobView(await installs.currentJob()),
    recoveryError: installs.health(),
  }));
  app.get(`${prefix}/jobs/:jobId`, {
    schema: { params: inputs.jobParams, response: responseSchemas.current },
  }, async (request: JobRequest) => ({
    job: jobView(await installs.getJob(request.params.jobId)),
    recoveryError: installs.health(),
  }));
  app.post(`${prefix}/versions`, {
    schema: { body: inputs.versions, response: responseSchemas.versions },
  }, async (request: FastifyRequest<{ Body: { url: unknown } }>) =>
    installs.listVersions(request.body.url));
  app.post(`${prefix}/jobs`, { schema: { body: inputs.install, response: responseSchemas.job } },
    async (request: FastifyRequest<{ Body: InstallRequest }>, reply) => {
      const job = jobView(await installs.startInstall(request.body));

      return reply.code(202).send({ job });
    });
  app.post(`${prefix}/jobs/:jobId/apply`, {
    schema: {
      params: inputs.jobParams,
      body: inputs.apply,
      response: responseSchemas.job,
    },
  }, async (request: JobRequest) =>
    ({ job: jobView(await installs.apply(request.params.jobId, request.body.reviewToken)) }));
  app.post(`${prefix}/jobs/:jobId/cancel`, {
    schema: {
      params: inputs.jobParams,
      body: inputs.empty,
      response: responseSchemas.job,
    },
  }, async (request: JobRequest) =>
    ({ job: jobView(await installs.cancel(request.params.jobId)) }));
  app.post(`${prefix}/${resource}/:id/update`, {
    schema: {
      params: inputs.pluginParams,
      body: inputs.update,
      response: responseSchemas.job,
    },
  }, async (request: UpdateRequest, reply) => {
    const job = jobView(await installs.startUpdate(request.params.id, request.body));

    return reply.code(202).send({ job });
  });
  app.post(`${prefix}/${resource}/:id/rollback`, {
    schema: {
      params: inputs.pluginParams,
      body: inputs.rollback,
      response: responseSchemas.job,
    },
  }, async (request: PluginRequest) =>
    ({ job: jobView(await installs.rollback(request.params.id, request.body)) }));

  if (driver) {
    app.post(`${prefix}/${resource}/:id/remove`, {
      schema: {
        params: inputs.pluginParams,
        body: inputs.empty,
      },
    }, async (request: FastifyRequest<{ Params: { id: string } }>) =>
      installs.remove(request.params.id));
  }

  app.post(`${prefix}/check`, {
    schema: { body: inputs.empty, response: responseSchemas.check },
  }, async () => ({ [driver ? 'drivers' : 'plugins']: await installs.checkUpdates() }));
}

/**
 * Archive ref допускает только подтверждённый basename с исходным plugin id.
 * Serializer удаляет unknown поля, но его string pattern не валидирует значения.
 */
function publicJob(job: PluginInstallJob | null): PluginInstallJob | null {
  if (job && job.backupRef !== null && (!job.pluginId || !validArchiveKey(job.backupRef, job.pluginId))) {
    throw installError('internal');
  }

  return job;
}

/**
 * Ошибки parser/validator сохраняют безопасный HTTP отказ без исходного текста.
 * Unknown значения проверяются по полям, прежде обращения к statusCode.
 */
function clientErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  if ('statusCode' in error && typeof error.statusCode === 'number'
    && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
    return error.statusCode;
  }

  return 'validation' in error && Array.isArray(error.validation) ? 400 : null;
}
