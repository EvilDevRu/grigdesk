// Модуль system — нагрузка домашнего ПК (CPU/RAM) + жизненный цикл самого сервера
// (режим запуска и перезапуск кнопкой из «Настройки → Сервер»).
import fp from 'fastify-plugin';
import { execFile, spawn } from 'node:child_process';
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
  // Статус пересборки web-бандла (см. эндпоинты ниже). В памяти процесса: перезапуск
  // сервера обнуляет его, а сиротевший npm при этом дособирает сам — dist не портится.
  let webRebuild = null;
  const rebuildBusy = () => webRebuild?.status === 'running';
  const rebuildConflict = (reply) => reply.code(409).send({
    error: 'rebuild_in_progress',
    message: 'Идёт пересборка web-бандла — дождитесь её конца.',
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
    // Гонка с пересборкой web: worker обновления публикует dist атомарным rename,
    // а бегущий vite build писал бы в него поверх старых исходников — мешанина.
    if (rebuildBusy()) return rebuildConflict(reply);
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
    if (rebuildBusy()) return rebuildConflict(reply);
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
  // бы второй экземпляр против юнита и отправил service в бесконечный restart loop
  // (см. комментарий в deploy/cockpit-server.service).
  fastify.post('/api/system/restart', async (_request, reply) => {
    // Рестарт гасит процесс → статус пересборки (в памяти) потеряется, а клиент
    // останется ждать. Проще запретить, чем восстанавливать неизвестное состояние.
    if (rebuildBusy()) return rebuildConflict(reply);
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

  // ── Пересборка web-бандла из текущего рабочего дерева ──
  // Лёгкий путь рядом с полным «применить checkout» (updates): без git-preflight,
  // временного снимка, smoke-тестов и перезапуска — npm install + vite build прямо
  // в web/. В сборку попадают и незакоммиченные правки (типовой случай: подправил
  // фронт и хочешь увидеть живьём). dist — статика, серверу перезапуск не нужен.
  function runNpm(args) {
    return new Promise((resolve) => {
      execFile('npm', args, {
        cwd: path.join(config.rootDir, 'web'),
        timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout = '', stderr = '') => resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        timedOut: !!error?.killed,
        output: `${stdout}\n${stderr}`,
      }));
    });
  }

  // Хвост вывода npm для сообщения об ошибке: полный лог мегабайты, а причина — внизу.
  function outputTail(text) {
    return String(text || '').split('\n').map((line) => line.trimEnd()).filter(Boolean)
      .slice(-8).join('\n').slice(-600);
  }

  async function rebuildWebBundle() {
    // `--include=dev` обязателен. Юнит кокпита ставит NODE_ENV=production, а `npm
    // install` наследует его от сервера и по этому признаку не просто пропускает
    // devDependencies, а ВЫЧИЩАЕТ уже стоящие. Весь инструмент сборки (vite,
    // @vitejs/plugin-vue, vite-plugin-pwa) лежит именно там — кнопка сносила то,
    // чем через строчку собирается бандл, и валилась на «vite: not found», оставив
    // web/node_modules без dev-зависимостей до ручного `npm install`.
    const install = await runNpm(['install', '--include=dev', '--no-audit', '--no-fund']);
    if (install.code !== 0) {
      return { code: 'web_dependencies_failed', message: `npm install завершился ошибкой${install.timedOut ? ' (таймаут)' : ''}.\n${outputTail(install.output)}` };
    }
    const build = await runNpm(['run', 'build']);
    if (build.code !== 0) {
      return { code: 'web_build_failed', message: `vite build завершился ошибкой${build.timedOut ? ' (таймаут)' : ''}.\n${outputTail(build.output)}` };
    }
    return null;
  }

  // Инъекция для тестов: реальный билд в них не гоняем.
  const webRebuilder = opts.webRebuilder || rebuildWebBundle;

  fastify.get('/api/system/web-rebuild', async () => ({ rebuild: webRebuild || { status: 'idle' } }));

  fastify.post('/api/system/web-rebuild', async (_request, reply) => {
    try { await updates.assertIdle(); }
    catch (error) { return sendReleaseError(reply, error); }
    if (rebuildBusy()) return rebuildConflict(reply);
    webRebuild = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null };
    // Сборка ~минута — дольше таймаутов гейтвея, поэтому фоном, а клиент опрашивает GET.
    Promise.resolve()
      .then(() => webRebuilder())
      .then((failure) => {
        webRebuild = {
          ...webRebuild, status: failure ? 'failed' : 'done',
          finishedAt: new Date().toISOString(), error: failure || null,
        };
      })
      .catch((error) => {
        webRebuild = {
          ...webRebuild, status: 'failed', finishedAt: new Date().toISOString(),
          error: { code: 'rebuild_failed', message: error?.message || 'Пересборка неожиданно завершилась.' },
        };
      });
    return reply.code(202).send({ ok: true });
  });

  await updates.recover?.();
  releases.start?.();
  fastify.addHook('onClose', async () => { releases.stop?.(); });
}

export default fp(systemModule, { name: 'module-system' });
