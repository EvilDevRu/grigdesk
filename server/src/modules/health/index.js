// Модуль health — базовая проверка живости и сводка окружения сервера.
import fp from 'fastify-plugin';
import os from 'node:os';

async function healthModule(fastify, opts) {
  const { config, factoryState } = opts;

  fastify.get('/api/health', async () => {
    let taskCount = 0;
    try {
      taskCount = (await factoryState.listTaskIds()).length;
    } catch { /* состояние недоступно — вернём 0 */ }
    return {
      ok: true,
      version: '0.0.1',
      uptimeSec: Math.round(process.uptime()),
      host: os.hostname(),
      stateDir: config.stateDir,
      factoryHome: config.factoryHome,
      taskCount,
    };
  });
}

export default fp(healthModule, { name: 'module-health' });
