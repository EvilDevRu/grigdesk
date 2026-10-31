import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { TrackerError } from '../../lib/trackers/contract.ts';
import type { TrackerRuntime } from '../../lib/trackers/runtime.ts';
import { createSerialQueue } from '../../lib/trackers/serialQueue.ts';
import installRoutes from './installRoutes.ts';

/**
 * Каталог содержит только описания и признаки готовности, никогда credentials.
 * Выбор защищён сессией, Origin, JSON и сравнением поколения перед записью.
 */
async function trackersModule(app: FastifyInstance, options: { runtime: TrackerRuntime }) {
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
  app.get('/api/trackers/settings', async () => publicSettings());
  app.post('/api/trackers/settings', async (request, reply) => {
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
          && !catalog.some((entry) => entry.id === body.externalId))) {
          throw new TrackerError('invalid_request', 'Неизвестный внешний драйвер');
        }

        const changes = isRecord(body.settings) ? body.settings : {};

        for (const [id, values] of Object.entries(changes)) {
          const entry = catalog.find((driver) => driver.id === id);

          if (!entry || !isRecord(values)) {
            throw new TrackerError('invalid_request', 'Неизвестные настройки драйвера');
          }

          for (const [key, value] of Object.entries(values)) {
            const field = entry.schema[key];

            if (!field || typeof value !== field.type) {
              throw new TrackerError('invalid_request', 'Некорректное поле драйвера');
            }
          }
        }

        await runtime.writeSettings(body.externalId, changes as Record<string, Record<string, unknown>>);
        await app.sse?.broadcast?.('trackers-changed', runtime.selection.read());

        return publicSettings();
      });
    } catch (error) {
      const known = error instanceof TrackerError;

      return reply.code(known ? error.status : 500).send({
        error: known ? error.code : 'tracker_settings_error',
        message: known ? error.message : 'Не удалось сохранить настройки трекера',
      });
    }
  });

  await app.register(installRoutes, { installs: runtime.installs });
}

export default fp(trackersModule, { name: 'module-trackers' });
