// Модуль factory (read-only, M0) — отдаёт состояние конвейера в чистом JSON,
// которого нет у Python-дашборда (там server-rendered HTML). Мутации (ворота/запуск)
// добавятся отдельным этапом через factory-cli.
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';
import { STAGES, StageKind } from '../../lib/stages.js';

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

  // Глобальный каталог стадий (enum) — для будущего редактора профилей.
  fastify.get('/api/factory/stages', async () => ({ kinds: StageKind, stages: STAGES }));

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

  // Запуск задачи на конвейер (замена входа через хук на mcp__b24__b24_task).
  // Контракт: factory bin при ошибке аргументов → rc≠0; при занятом локе → rc=0.
  // Исход читаем из состояния (ORCH_PID + /proc), не из stdout.
  fastify.post('/api/tasks/:id/launch', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const { ticket, route, profile: reqProfile } = request.body || {};
    const profile = reqProfile || config.factoryProfile || (await factoryState.primaryProfile());
    if (!profile) return reply.code(400).send({ error: 'no_profile', message: 'профиль конвейера не определён' });

    // Уже идёт?
    let reg = null;
    try { reg = (await factoryState.readRegistry(id)).registry; } catch { /* реестра ещё нет */ }
    if (reg && factoryState.isDaemonAlive(reg.ORCH_PID, id)) return { outcome: 'already_running', profile };

    const args = [id, 'start', '--profile', profile];
    if (ticket) args.push('--ticket', String(ticket).slice(0, 4000));
    if (route) args.push('--route', route);
    const rc = await new Promise((res) => execFile(config.factoryBin, args, { timeout: 20000 }, (err) => res(err ? (err.code ?? 1) : 0)));
    if (rc !== 0) return reply.code(500).send({ outcome: 'invalid', message: 'factory bin: ошибка аргументов/профиля/маршрута' });

    // Опрос ORCH_PID до ~10с.
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => { setTimeout(r, 250); });
      try {
        const r2 = (await factoryState.readRegistry(id)).registry;
        if (factoryState.isDaemonAlive(r2.ORCH_PID, id)) return { outcome: 'launched', profile };
      } catch { /* реестр ещё пишется */ }
    }
    return { outcome: 'started', profile, note: 'демон не подтвердил PID за 10с — проверь конвейер' };
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
