// Модуль system — нагрузка домашнего ПК (CPU/RAM). Дальше сюда добавим docker/песочницы.
import fp from 'fastify-plugin';

async function systemModule(fastify, opts) {
  const { system } = opts;
  fastify.get('/api/system', async () => system.read());
}

export default fp(systemModule, { name: 'module-system' });
