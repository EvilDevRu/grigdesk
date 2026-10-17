import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Ajv } from 'ajv';
import type { AnySchema } from 'ajv';
import { inputs, outputs } from './installSchemas.ts';
import type { InstallRequest, PluginInstallPort, RollbackRequest } from '../../lib/pluginInstall/service.ts';
import { errorInfo, installError, PluginInstallError } from '../../lib/pluginInstall/errors.ts';

import type { PluginInstallJob } from '../../../../shared/plugins/pluginInstallContracts.ts';
import { validArchiveKey } from '../../lib/pluginInstall/stateValidation.ts';

type JobRequest = FastifyRequest<{ Params: { jobId: string }; Body: { reviewToken: string } }>;
type PluginRequest = FastifyRequest<{ Params: { id: string }; Body: RollbackRequest }>;
type UpdateRequest = FastifyRequest<{
  Params: { id: string };
  Body: Omit<InstallRequest, 'url' | 'expectedId'>;
}>;

/**
 * Установка имеет свой encapsulated HTTP scope и отдельный session допуск.
 * Чтение исхода остаётся доступным всем авторизованным transport ядра.
 */
export default async function installRoutes(
  app: FastifyInstance,
  { installs }: { installs: PluginInstallPort },
): Promise<void> {
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

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'POST' && request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required', message: 'Требуется сессия браузера.' });
    }

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

  app.get('/api/plugin-installs/jobs/current', { schema: { response: outputs.current } }, async () => ({
    job: publicJob(await installs.currentJob()),
    recoveryError: installs.health(),
  }));
  app.get('/api/plugin-installs/jobs/:jobId', {
    schema: { params: inputs.jobParams, response: outputs.current },
  }, async (request: JobRequest) => ({
    job: publicJob(await installs.getJob(request.params.jobId)),
    recoveryError: installs.health(),
  }));
  app.post('/api/plugin-installs/versions', {
    schema: { body: inputs.versions, response: outputs.versions },
  }, async (request: FastifyRequest<{ Body: { url: unknown } }>) =>
    installs.listVersions(request.body.url));
  app.post('/api/plugin-installs/jobs', { schema: { body: inputs.install, response: outputs.job } },
    async (request: FastifyRequest<{ Body: InstallRequest }>, reply) => {
      const job = publicJob(await installs.startInstall(request.body));

      return reply.code(202).send({ job });
    });
  app.post('/api/plugin-installs/jobs/:jobId/apply', {
    schema: {
      params: inputs.jobParams,
      body: inputs.apply,
      response: outputs.job,
    },
  }, async (request: JobRequest) =>
    ({ job: publicJob(await installs.apply(request.params.jobId, request.body.reviewToken)) }));
  app.post('/api/plugin-installs/jobs/:jobId/cancel', {
    schema: {
      params: inputs.jobParams,
      body: inputs.empty,
      response: outputs.job,
    },
  }, async (request: JobRequest) =>
    ({ job: publicJob(await installs.cancel(request.params.jobId)) }));
  app.post('/api/plugin-installs/plugins/:id/update', {
    schema: {
      params: inputs.pluginParams,
      body: inputs.update,
      response: outputs.job,
    },
  }, async (request: UpdateRequest, reply) => {
    const job = publicJob(await installs.startUpdate(request.params.id, request.body));

    return reply.code(202).send({ job });
  });
  app.post('/api/plugin-installs/plugins/:id/rollback', {
    schema: {
      params: inputs.pluginParams,
      body: inputs.rollback,
      response: outputs.job,
    },
  }, async (request: PluginRequest) =>
    ({ job: publicJob(await installs.rollback(request.params.id, request.body)) }));
  app.post('/api/plugin-installs/check', {
    schema: { body: inputs.empty, response: outputs.check },
  }, async () => ({ plugins: await installs.checkUpdates() }));
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
