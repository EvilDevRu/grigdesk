// Маршрут окна «Ключи доступа» в плашке исполнителя. Какие переменные можно задать,
// объявляет адаптер; запись идёт в корневой .env общим писателем и сразу в окружение
// процесса. Кэши реестра и лимитов принадлежат модулю providers: маршрут только просит
// их сбросить и перечитать каталог моделей.
import type { FastifyInstance } from 'fastify';

import {
  applyCredentialValues,
  credentialViews,
  declaredCredentials,
  envFileNames,
} from '../../lib/executorCredentials.ts';
import type { ExecutorAdapter } from '../../lib/executors/index.ts';

export interface ProviderCredentialsOptions {
  config: { envPath?: string };
  adaptersOf: () => Promise<Map<string, ExecutorAdapter>>;
  // Окружение, которое видят исполнители; в тестах — подменённый объект.
  env: NodeJS.ProcessEnv;
  resetRegistry: (providerId: string) => void;
  resetUsage: (providerId: string) => void;
  refreshModels: () => Promise<unknown>;
}

interface ProviderCredentialsRoute {
  Params: { id: string };
  Body: { values?: unknown };
}

/**
 * Регистрирует `POST /api/providers/:id/credentials`. Принимаются только объявленные
 * адаптером переменные. Каталог моделей перечитывается с новым ключом в фоне: окно не
 * ждёт CLI и сеть всех исполнителей, свежий список приходит событием providers-update.
 */
export function registerProviderCredentials(
  fastify: FastifyInstance,
  { config, adaptersOf, env, resetRegistry, resetUsage, refreshModels }: ProviderCredentialsOptions,
): void {
  fastify.post<ProviderCredentialsRoute>('/api/providers/:id/credentials', async (request, reply) => {
    const adapter = (await adaptersOf()).get(String(request.params.id));

    if (!adapter) {
      return reply.code(404).send({ error: 'unknown_provider' });
    }

    const declarations = await declaredCredentials(adapter, config);

    if (!declarations.length) {
      return reply.code(400).send({
        error: 'no_credentials',
        message: `исполнитель ${adapter.name} не объявляет ключей доступа`,
      });
    }

    if (!config.envPath) {
      return reply.code(503).send({ error: 'env_file_unconfigured', message: 'Путь к .env не задан.' });
    }

    const result = await applyCredentialValues({
      declarations,
      input: request.body?.values,
      envPath: config.envPath,
      env,
    });

    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    fastify.log.info(
      { provider: adapter.id, changed: result.changed },
      'ключи доступа исполнителя обновлены',
    );
    resetRegistry(adapter.id);
    resetUsage(adapter.id);
    fastify.sse?.broadcast?.('providers-update', { credentials: adapter.id });
    Promise.resolve()
      .then(() => refreshModels())
      .catch(() => null)
      .finally(() => {
        // Снимок, собранный во время перечитывания, мог взять прежний каталог.
        resetRegistry(adapter.id);
        fastify.sse?.broadcast?.('providers-update', {});
      });

    return {
      ok: true,
      changed: result.changed,
      credentials: credentialViews(declarations, env, await envFileNames(config.envPath)),
    };
  });
}
