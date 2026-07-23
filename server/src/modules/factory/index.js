// Модуль factory (read-only, M0) — отдаёт состояние конвейера в чистом JSON,
// которого нет у Python-дашборда (там server-rendered HTML). Мутации (ворота/запуск)
// добавятся отдельным этапом через factory-cli.
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';

async function factoryModule(fastify, opts) {
  const { factoryState, config } = opts;

  // Список всех задач с картой статусов этапов.
  fastify.get('/api/tasks', async () => {
    const tasks = await factoryState.listTasks();
    return { tasks };
  });

  // Деталь одной задачи: реестр + карта этапов + таймлайн.
  fastify.get('/api/tasks/:id', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      return await factoryState.getTaskDetail(id);
    } catch (err) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
  });

  // Эталонные схемы маршрутов. Профиль — из запроса, иначе определяется по данным
  // (активные задачи / обнаруженные схемы). Пустой кокпит вернёт profile:null.
  fastify.get('/api/factory/routes', async (request, reply) => {
    try {
      const profile = request.query.profile || (await factoryState.primaryProfile());
      const profiles = factoryState.discoverProfiles();
      if (!profile) return { profile: null, profiles, default: null, routes: {} };
      return { ...factoryState.getRoutes(profile), profiles };
    } catch (err) {
      return reply.code(500).send({ error: 'graph_error', message: err.message });
    }
  });

  // Снос стенда задачи. Команда проектно-специфична — задаётся окружением
  // (COCKPIT_SANDBOX_DOWN_CMD, {task} подставляется). Не настроено → 501.
  fastify.post('/api/tasks/:id/sandbox/down', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    if (!config.sandboxDownCmd) {
      return reply.code(501).send({ error: 'not_configured', message: 'COCKPIT_SANDBOX_DOWN_CMD не задан' });
    }
    const cmd = config.sandboxDownCmd.replaceAll('{task}', id);
    return new Promise((resolve) => {
      execFile('sh', ['-c', cmd], { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) resolve(reply.code(500).send({ error: 'sandbox_down_failed', message: (stderr || err.message).slice(-500) }));
        else resolve({ ok: true, output: (stdout || '').slice(-500) });
      });
    });
  });

  // Полный граф конвейера задачи (для SVG-отрисовки): схема + статусы узлов + возвраты.
  fastify.get('/api/tasks/:id/graph', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      return await factoryState.getTaskGraph(id);
    } catch (err) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
  });
}

export default fp(factoryModule, { name: 'module-factory' });
