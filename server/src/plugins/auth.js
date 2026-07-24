// Плагин авторизации кокпита.
// Модель прав из плана: GET — свободно внутри доверенной сети (Tailscale); мутации
// (POST/PUT/PATCH/DELETE) — по заголовку `X-Cockpit-Token`, если токен задан в конфиге.
// Пустой токен = мутации открыты (локальная/доверенная сеть), с предупреждением в лог.
import fp from 'fastify-plugin';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function authPlugin(fastify, opts) {
  const token = opts.mutateToken || '';
  if (!token) {
    fastify.log.warn('COCKPIT_TOKEN не задан — мутации открыты внутри доверенной сети. Для боевого доступа задайте токен.');
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (!MUTATING.has(request.method)) return; // чтение — свободно
    if (!token) return; // токен не настроен — пропускаем (доверенная сеть)
    const provided = request.headers['x-cockpit-token'];
    if (provided !== token) {
      reply.code(401).send({ error: 'unauthorized', message: 'Неверный или отсутствующий X-Cockpit-Token для мутации.' });
    }
  });
}

export default fp(authPlugin, { name: 'cockpit-auth' });
