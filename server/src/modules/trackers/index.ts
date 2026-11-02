import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isRecord } from '../../../../shared/lib/objects.ts';
import type { TrackerDescriptor } from '../../../../shared/trackers/contracts.ts';
import {
  isTrackerTokenInput, visibleTrackerTokenKeys,
} from '../../../../shared/trackers/settingsValidation.ts';
import { TrackerError } from '../../lib/trackers/contract.ts';
import { readDriverSources } from '../../lib/trackers/driverSources.ts';
import type { TrackerRuntime } from '../../lib/trackers/runtime.ts';
import { createSerialQueue } from '../../lib/trackers/serialQueue.ts';
import installRoutes from './installRoutes.ts';

class TrackerTokenError extends TrackerError {
  readonly driverId: string;
  readonly field: string;

  constructor(driverId: string, field: string, message: string) {
    super('tracker_token_invalid', message);
    this.driverId = driverId;
    this.field = field;
  }
}

/**
 * Реквизиты принимает только браузерная сессия с JSON и своим Origin.
 * Одинаковая защита применяется к сохранению и проверке несохранённого черновика.
 */
async function requireSettingsSession(request: FastifyRequest, reply: FastifyReply) {
  if (request.authKind !== 'session') {
    return reply.code(403).send({ error: 'session_required' });
  }

  if (request.headers.origin !== undefined) {
    try {
      if (new URL(request.headers.origin).origin
        !== new URL(`${request.protocol}://${request.headers.host}`).origin) {
        return reply.code(403).send({ error: 'origin_forbidden' });
      }
    } catch {
      return reply.code(403).send({ error: 'origin_forbidden' });
    }
  }

  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    return reply.code(415).send({ error: 'unsupported_media_type' });
  }
}

/**
 * Проверка и сохранение принимают одинаковые поля декларативной схемы.
 * Неизвестный драйвер, лишнее поле и значение вне select отклоняются до вызова пакета.
 */
function validateSettings(
  entry: TrackerDescriptor | undefined,
  values: unknown,
): Record<string, unknown> {
  if (!entry || entry.deleted || !isRecord(values)) {
    throw new TrackerError('invalid_request', 'Неизвестные настройки драйвера');
  }

  for (const [key, value] of Object.entries(values)) {
    const field = entry.schema[key];
    const valid = field?.type === 'select'
      ? typeof value === 'string' && field.options.some((option) => option.value === value)
      : field && typeof value === field.type && (field.type !== 'number' || Number.isFinite(value));

    if (!valid) {
      throw new TrackerError('invalid_request', 'Некорректное поле драйвера');
    }
  }

  return values;
}

/**
 * Проверяется только видимый токен текущего режима; пустой ввод сохраняет секрет.
 * Ошибка содержит имя поля, но никогда не включает введённое значение.
 */
function validateTokenInput(entry: TrackerDescriptor, values: Record<string, unknown>) {
  for (const key of visibleTrackerTokenKeys(entry.schema, values)) {
    if (entry.schema[key]?.required && (typeof values[key] !== 'string' || values[key] === '')) {
      throw new TrackerTokenError(entry.id, key,
        'Укажите API-токен трекера. Пароль учётной записи не подходит.');
    }

    if (typeof values[key] === 'string' && !isTrackerTokenInput(values[key])) {
      throw new TrackerTokenError(entry.id, key,
        'Вставьте API-токен целиком без пробелов, кавычек и префикса Bearer. Пароль не подходит.');
    }
  }
}

/**
 * Каталог содержит только описания и признаки готовности, никогда credentials.
 * Выбор защищён сессией, Origin, JSON и сравнением поколения перед записью.
 */
async function trackersModule(app: FastifyInstance, options: {
  runtime: TrackerRuntime;
  driverSourcesPath: string;
}) {
  const { runtime } = options;
  const serial = createSerialQueue();
  const publicSettings = () => {
    const settings: Record<string, Record<string, unknown>> = {};

    for (const entry of runtime.registry.descriptors()) {
      const values = runtime.credsStore.readFor(entry.id) ?? {};

      settings[entry.id] = Object.fromEntries(Object.entries(entry.schema)
        .filter(([, field]) => !field.secret)
        .map(([key]) => [key, values[key] ?? '']));
    }

    return { ...runtime.selection.read(), settings };
  };

  app.get('/api/trackers', async () => runtime.catalog());
  app.get('/api/trackers/sources', async () => ({
    sources: await readDriverSources(options.driverSourcesPath, app.log),
  }));
  app.get('/api/trackers/settings', async () => publicSettings());
  app.post('/api/trackers/settings', { preHandler: requireSettingsSession }, async (request, reply) => {
    try {
      return await serial(async () => {
        const body = request.body;

        if (!isRecord(body) || (body.externalId !== null && typeof body.externalId !== 'string')
          || Object.keys(body).some((key) => !['externalId', 'settings', 'expectedRevision'].includes(key))
          || (body.settings !== undefined && !isRecord(body.settings))) {
          throw new TrackerError('invalid_request', 'Некорректные настройки трекера');
        }

        runtime.selection.assertRevision(body.expectedRevision);

        const catalog = runtime.registry.descriptors();

        if (body.externalId === 'own' || (body.externalId !== null
          && !catalog.some((entry) => entry.id === body.externalId && !entry.deleted))) {
          throw new TrackerError('invalid_request', 'Неизвестный внешний драйвер');
        }

        const rawChanges = isRecord(body.settings) ? body.settings : {};
        const changes = Object.fromEntries(Object.entries(rawChanges).map(([id, input]) => {
          const entry = catalog.find((driver) => driver.id === id);
          const values = validateSettings(entry, input);

          validateTokenInput(entry!, runtime.credsStore.mergeFor(id, values));

          return [id, values] as const;
        }));

        for (const [id, values] of Object.entries(changes)) {
          const entry = catalog.find((driver) => driver.id === id)!;
          const merged = runtime.credsStore.mergeFor(id, values);
          const changedField = visibleTrackerTokenKeys(entry.schema, merged)
            .find((key) => typeof values[key] === 'string' && values[key] !== '');

          if (changedField) {
            const result = await runtime.testConnection(id, values);

            if (!result.ok) {
              throw new TrackerTokenError(id, changedField,
                `Не удалось проверить API-токен. Нужен токен, а не пароль. ${result.error ?? ''}`);
            }
          }
        }

        runtime.selection.assertRevision(body.expectedRevision);
        await runtime.writeSettings(body.externalId, changes);
        await app.sse?.broadcast?.('trackers-changed', runtime.selection.read());

        return publicSettings();
      });
    } catch (error) {
      const known = error instanceof TrackerError;

      return reply.code(known ? error.status : 500).send({
        error: known ? error.code : 'tracker_settings_error',
        message: known ? error.message : 'Не удалось сохранить настройки трекера',
        ...(error instanceof TrackerTokenError ? { driverId: error.driverId, field: error.field } : {}),
      });
    }
  });

  app.post('/api/trackers/test-connection', {
    preHandler: requireSettingsSession,
  }, async (request, reply) => {
    try {
      return await serial(async () => {
        const body = request.body;

        if (!isRecord(body) || typeof body.driverId !== 'string' || body.driverId === 'own'
          || Object.keys(body).some((key) => !['driverId', 'settings', 'expectedRevision'].includes(key))) {
          throw new TrackerError('invalid_request', 'Некорректные параметры проверки трекера');
        }

        runtime.selection.assertRevision(body.expectedRevision);

        const entry = runtime.registry.descriptors().find((driver) => driver.id === body.driverId);
        const values = validateSettings(entry, body.settings);

        validateTokenInput(entry!, runtime.credsStore.mergeFor(body.driverId, values));

        const result = await runtime.testConnection(body.driverId, values);

        runtime.selection.assertRevision(body.expectedRevision);

        return result;
      });
    } catch (error) {
      const known = error instanceof TrackerError;

      return reply.code(known ? error.status : 502).send({
        error: known ? error.code : 'tracker_connection_error',
        message: known ? error.message : 'Не удалось проверить подключение трекера',
        ...(error instanceof TrackerTokenError ? { driverId: error.driverId, field: error.field } : {}),
      });
    }
  });

  await app.register(installRoutes, { installs: runtime.installs });
}

export default fp(trackersModule, { name: 'module-trackers' });
