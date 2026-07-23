// Модуль factory (read-only, M0) — отдаёт состояние конвейера в чистом JSON,
// которого нет у Python-дашборда (там server-rendered HTML). Мутации (ворота/запуск)
// добавятся отдельным этапом через factory-cli.
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';
import { STAGES, StageKind } from '../../lib/stages.js';
import { setPipeline, writeInstruction, readInstruction, readActivity } from '../../lib/factory-cli.js';

// Допустимые статусы для ручного перехода (форс).
const STAGE_STATUSES = new Set(['pending', 'running', 'done', 'waiting', 'skipped', 'failed', 'approved', 'rejected']);

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

  const cfg = { factoryHome: config.factoryHome, stateDir: config.stateDir };

  // Ворота: принять/отклонить (+ комментарий агенту при отклонении).
  fastify.post('/api/tasks/:id/gate/:key/:decision', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const key = String(request.params.key).toUpperCase();
    const decision = request.params.decision;
    if (!id || !(key.startsWith('GATE_') || key === 'DEMO_ASK')) return reply.code(400).send({ error: 'bad_gate' });
    if (!['approve', 'reject'].includes(decision)) return reply.code(400).send({ error: 'bad_decision' });
    const value = decision === 'approve' ? 'approved' : 'rejected';
    const comment = ((request.body || {}).comment || '').replace(/\n/g, ' ').slice(0, 500);
    const pairs = [key, value];
    if (comment) pairs.push(`${key}_COMMENT`, comment);
    try { await setPipeline({ ...cfg, task: id, pairs }); return { ok: true, key, value }; }
    catch (err) { return reply.code(500).send({ error: 'gate_failed', message: err.message }); }
  });

  // Принудительный переход/статус этапа (форс).
  fastify.post('/api/tasks/:id/stage/:key/:status', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const key = String(request.params.key).toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const status = request.params.status;
    if (!id || !key) return reply.code(400).send({ error: 'bad_input' });
    if (!STAGE_STATUSES.has(status)) return reply.code(400).send({ error: 'bad_status' });
    try { await setPipeline({ ...cfg, task: id, pairs: [key, status] }); return { ok: true, key, status }; }
    catch (err) { return reply.code(500).send({ error: 'stage_failed', message: err.message }); }
  });

  // Указание агенту (side-файл, читается на границе этапов). Пусто — снять.
  fastify.get('/api/tasks/:id/instruction', async (request) => ({ text: readInstruction({ ...cfg, task: String(request.params.id).replace(/[^0-9]/g, '') }) }));
  fastify.post('/api/tasks/:id/instruction', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      writeInstruction({ ...cfg, task: id, text: (request.body || {}).text || '' });
      if ((request.body || {}).text) await setPipeline({ ...cfg, task: id, pairs: ['INSTRUCTION_AT', new Date().toISOString().slice(0, 19).replace('T', ' ')] }).catch(() => {});
      return { ok: true };
    } catch (err) { return reply.code(500).send({ error: 'instruction_failed', message: err.message }); }
  });

  // Живая активность прогона (для поллинга в модалке).
  fastify.get('/api/tasks/:id/activity', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      const { registry } = await factoryState.readRegistry(id);
      return readActivity({ ...cfg, task: id, registry });
    } catch (err) { return reply.code(404).send({ error: 'not_found', message: err.message }); }
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
