import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

import { WEB_LOG_LIMITS, projectWebLogEntry } from '../../../../shared/web-log/webLogContracts.ts';
import { filterWebLogEntry } from '../../../../shared/web-log/diagnosticLogging.ts';
import { createWebLogStore, validUtcDay } from '../../lib/webLog/store.ts';
import type { WebLogEntry } from '../../../../shared/web-log/webLogContracts.ts';
import type { ApiRouteRegistry } from '../../lib/webLog/apiRoutes.ts';
import type { DiagnosticLoggingPolicy } from '../../lib/diagnosticLogging.ts';

export type WebLogModuleOptions = {
  dir: string;
  policy: Pick<DiagnosticLoggingPolicy, 'level'>;
  // Без реестра (изолированные проверки) путь /api проверяется только по форме.
  apiRoutes?: Pick<ApiRouteRegistry, 'has' | 'list'>;
  now?: () => Date;
  segmentBytes?: number;
  maxTotalBytes?: number;
  maxArchives?: number;
};

/**
 * Пачка проходит общую проекцию целиком до записи: любая негодная запись
 * отклоняет всю пачку, а наружу не уходит ни байта исходного тела.
 */
function projectBatch(
  raw: unknown,
  apiRoutes: WebLogModuleOptions['apiRoutes'],
): WebLogEntry[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const body = raw as { v?: unknown; entries?: unknown };

  if (
    body.v !== 1 || !Array.isArray(body.entries) || body.entries.length < 1
    || body.entries.length > WEB_LOG_LIMITS.serverEntries
  ) {
    return null;
  }

  const entries: WebLogEntry[] = [];

  for (const candidate of body.entries) {
    const entry = projectWebLogEntry(candidate, { apiRoutes });

    if (!entry) {
      return null;
    }

    entries.push(entry);
  }

  return entries;
}

/**
 * Модуль использует общий auth guard /api. Тело валидируется целиком до append;
 * все ошибки наружу отдаются без исходного текста запроса.
 */
async function webLogModule(fastify: FastifyInstance, options: WebLogModuleOptions): Promise<void> {
  const store = createWebLogStore(options);

  fastify.addHook('onClose', async () => store.close());

  fastify.post('/api/web-log', { bodyLimit: WEB_LOG_LIMITS.serverBytes }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    const entries = projectBatch(request.body, options.apiRoutes);

    if (!entries) {
      return reply.code(400).send({ error: 'bad_web_log' });
    }

    try {
      const level = await options.policy.level();
      const changed = entries.some((entry) => {
        const filtered = filterWebLogEntry(level, entry);

        return !filtered || filtered.dump?.entries.length !== entry.dump?.entries.length;
      });

      if (changed) {
        return reply.code(409).send({ error: 'logging_policy_changed', level });
      }

      return await store.append(entries);
    } catch {
      request.log.error('Журнал окна: запись недоступна');

      return reply.code(503).send({ error: 'web_log_unavailable' });
    }
  });

  // Каталог шаблонов /api: окно сводит к ним реальные пути до записи отказа.
  fastify.get('/api/web-log/routes', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');

    return { routes: options.apiRoutes?.list() ?? [] };
  });

  fastify.get('/api/web-log/download', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    const query = request.query as { day?: unknown };

    if (!validUtcDay(query.day)) {
      return reply.code(400).send({ error: 'bad_day' });
    }

    try {
      const stream = await store.download(query.day);

      if (!stream) {
        return reply.code(404).send({ error: 'web_log_not_found' });
      }

      reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="web-log-${query.day}.ndjson"`);

      return reply.send(stream);
    } catch {
      request.log.error('Журнал окна: чтение недоступно');

      return reply.code(503).send({ error: 'web_log_unavailable' });
    }
  });
}

export default fp(webLogModule, { name: 'module-web-log' });
