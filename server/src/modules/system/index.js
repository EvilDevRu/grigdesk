// Модуль system — нагрузка домашнего ПК (CPU/RAM) + жизненный цикл самого сервера
// (режим запуска и перезапуск кнопкой из «Настройки → Сервер»).
import fp from 'fastify-plugin';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { CockpitReleaseService } from '../../lib/cockpit-release.js';
import { CockpitUpdateManager } from '../../lib/cockpit-update.js';

async function systemModule(fastify, opts) {
  const { system, config } = opts;
  const releases = opts.releases || new CockpitReleaseService({
    rootDir: config.rootDir,
    statePath: config.cockpitUpdateStatePath,
    broadcast: (event, data) => fastify.sse?.broadcast(event, data),
  });
  const updates = opts.updates || new CockpitUpdateManager({
    releases,
    rootDir: config.rootDir,
    statePath: config.cockpitUpdateStatePath,
  });
  fastify.get('/api/system', async () => system.read());

  // GET принципиально локальный: HEAD/status + сохранённый результат последней remote-
  // проверки. Сеть разрешена только явному POST и редкому фоновому таймеру.
  fastify.get('/api/system/version', async () => releases.getStatus());
  fastify.post('/api/system/version/check', async () => releases.checkRemote());
  fastify.get('/api/system/update-job', async () => ({ job: await updates.getJob() }));

  function sendReleaseError(reply, error) {
    if (!error?.statusCode || !error?.code) throw error;
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }

  fastify.post('/api/system/apply', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['expectedCheckoutSha'],
        propertyNames: { enum: ['expectedCheckoutSha', 'allowDirty'] },
        properties: {
          expectedCheckoutSha: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' },
          allowDirty: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const job = await updates.startApply(request.body);
      return reply.code(202).send({ ok: true, job });
    } catch (error) { return sendReleaseError(reply, error); }
  });

  fastify.post('/api/system/update', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['targetTag', 'expectedCheckoutSha'],
        propertyNames: { enum: ['targetTag', 'expectedCheckoutSha'] },
        properties: {
          targetTag: { type: 'string', pattern: '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' },
          expectedCheckoutSha: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const job = await updates.startUpdate(request.body);
      return reply.code(202).send({ ok: true, job });
    } catch (error) { return sendReleaseError(reply, error); }
  });

  // Под systemd у процесса сервиса есть INVOCATION_ID — по нему выбирается способ перезапуска.
  const underSystemd = () => !!process.env.INVOCATION_ID;

  // Режим запуска — для блока «Сервер» в настройках.
  fastify.get('/api/system/server', async () => ({
    systemd: underSystemd(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  }));

  // Перезапуск сервера. Ответ уходит ДО смерти процесса (задержка), иначе кнопка не
  // узнает, что нажалась. Под systemd — просто выход: юнит с Restart=always поднимет
  // чистую копию и подтянет новый код после деплоя. При ручном запуске поднимать некому,
  // поэтому bin/restart отвязанным процессом (переживает смерть родителя: detached здесь
  // + setsid внутри самого скрипта). РЕЖИМЫ НЕ СМЕШИВАЕМ: bin/restart под systemd поднял
  // бы второй экземпляр против юнита — ровно так юнит намотал 7553 падения 27.07.2026
  // (см. комментарий в deploy/cockpit-server.service).
  fastify.post('/api/system/restart', async (_request, reply) => {
    try { await updates.assertIdle(); }
    catch (error) { return sendReleaseError(reply, error); }
    const systemd = underSystemd();
    setTimeout(() => {
      if (systemd) { process.exit(0); return; }
      const child = spawn('bash', [path.join(config.rootDir, 'bin', 'restart')], {
        detached: true, stdio: 'ignore', cwd: config.rootDir,
      });
      child.unref();
    }, 400);
    return { ok: true, mode: systemd ? 'systemd' : 'script' };
  });

  await updates.recover?.();
  releases.start?.();
  fastify.addHook('onClose', async () => { releases.stop?.(); });
}

export default fp(systemModule, { name: 'module-system' });
