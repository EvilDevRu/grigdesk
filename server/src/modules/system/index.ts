// Модуль system — нагрузка домашнего ПК (CPU/RAM) + жизненный цикл самого сервера
// (режим запуска, перезапуск, автозапуск и ярлык — из «Настройки → Сервер»).
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

import { config as runtimeConfig } from '../../config.ts';
import { PackagedReleaseService, PackagedUpdateManager, readInstallVersion }
  from '../../lib/packagedRelease.ts';
import { ReleaseChannelService } from '../../lib/releaseChannel.ts';
import type { GrigDeskReleaseService } from '../../lib/grigDeskRelease.ts';
import type { GrigDeskUpdateManager } from '../../lib/grigDeskUpdate.ts';
import { createReleaseServices } from '../../lib/releaseServices.ts';
import { PACKAGE_UPDATE_ERROR, PACKAGE_UPDATE_MESSAGE } from '../../lib/packagedRelease.ts';
import { runtimeInstallationRoot, runtimeKind } from '../../lib/runtimePaths.ts';
import type { RuntimeKind } from '../../lib/runtimePaths.ts';
import { DESKTOP_RESTART_EXIT_CODE } from '../../lib/desktopParent.ts';
import type { DesktopParent } from '../../lib/desktopParent.ts';
import { LauncherError, LauncherService } from '../../lib/launcher.ts';
import type { SystemAdapter } from '../../adapters/system.ts';

// Отказ пересборки словами: машинный код для интерфейса и текст человеку.
interface RebuildFailure {
  code: string;
  message: string;
}

// Состояние пересборки бандла. Живёт в памяти процесса — см. комментарий ниже.
interface WebRebuildState {
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: RebuildFailure | null;
}

// Отказ релиза уже назван кодом и статусом; всё остальное — не наша ошибка.
interface ReleaseError {
  statusCode?: number;
  code?: string;
  message?: string;
}

// Тела мутаций проверяет схема Fastify, поэтому здесь объявлена уже проверенная форма.
interface ApplyRoute {
  Body: { expectedCheckoutSha: string; allowDirty?: boolean };
}

interface UpdateRoute {
  Body: { targetTag: string; expectedCheckoutSha: string };
}

interface PackageUpdateRoute {
  Body: {
    expectedVersion: string;
    expectedArchiveSha256: string
  };
}

interface UpdateRestartRoute {
  Body: { jobId: string };
}

interface AutostartRoute {
  Body: { enabled: boolean };
}

// Серверный config в объёме раздела. Полная форма — в config.ts.
interface SystemModuleConfig {
  rootDir: string;
  grigDeskUpdateStatePath: string;
  port: number;
  cliTokenPath: string;
}

export interface SystemModuleOptions {
  system: SystemAdapter;
  config: SystemModuleConfig;
  releases?: GrigDeskReleaseService | PackagedReleaseService;
  updates?: GrigDeskUpdateManager | PackagedUpdateManager;
  // Подмена для тестов: реальный билд в них не гоняем.
  webRebuilder?: () => Promise<RebuildFailure | null>;
  // Подмена для тестов: systemctl и ярлык в них не трогаем.
  launcher?: LauncherService;
  serverMode?: () => 'desktop' | 'systemd' | 'manual';
  restartViaScript?: (rootDir: string) => void;
  desktop?: DesktopParent | null;
  runtimeKind?: () => RuntimeKind;
}

/**
 * Ручной сервер передаёт перезапуск прежнему скрипту вне текущего процесса.
 * В тестах этот эффект заменяется портом, чтобы не затронуть живой GrigDesk.
 */
function restartViaScript(rootDir: string): void {
  const child = spawn('bash', [path.join(rootDir, 'deploy', 'restart.sh')], {
    detached: true,
    stdio: 'ignore',
    cwd: rootDir,
  });

  child.unref();
}

/**
 * Связывает настройки сервера с безопасным выбором режима и способа перезапуска.
 * Порты эффектов позволяют проверить маршруты без запуска настоящих системных команд.
 */
async function systemModule(
  fastify: FastifyInstance,
  opts: SystemModuleOptions,
): Promise<void> {
  const { system, config } = opts;
  const serverMode = opts.serverMode ?? (() => opts.desktop ? 'desktop'
    : process.env.INVOCATION_ID ? 'systemd' : 'manual');
  const restartScript = opts.restartViaScript ?? restartViaScript;

  const packaged = (opts.runtimeKind ?? runtimeKind)() === 'packaged';
  // Packaged-сервисы собираются здесь и передаются фабрике через opts: инъекции
  // тестов (opts.releases/opts.updates) имеют приоритет, как у source-ветки.
  const packagedInstallRoot = runtimeInstallationRoot();
  const packagedChannel = packaged ? new ReleaseChannelService() : undefined;
  const packagedReleases = opts.releases ?? (packaged
    ? new PackagedReleaseService(config.rootDir, undefined, {
      channel: packagedChannel,
      installVersionReader: () => {
        return readInstallVersion(packagedInstallRoot);
      },
    })
    : undefined);
  const packagedUpdates = opts.updates ?? (packaged
    ? new PackagedUpdateManager({
      installRoot: packagedInstallRoot,
      statePath: path.join(runtimeConfig.dataHome, 'state',
        'grigdesk-package-update.json'),
      channel: packagedChannel,
      onRestart: () => {
        return schedulePackageRestart();
      },
    })
    : undefined);
  const { releases, updates } = createReleaseServices({
    rootDir: config.rootDir,
    statePath: config.grigDeskUpdateStatePath,
    kind: packaged ? 'packaged' : 'source',
    releases: packagedReleases,
    updates: packagedUpdates,
    broadcast: (event, data) => fastify.sse?.broadcast?.(event, data),
    desktop: () => Boolean(opts.desktop?.connected),
    origin: `http://127.0.0.1:${config.port}`,
    cliTokenPath: config.cliTokenPath,
  });
  // Статус пересборки web-бандла (см. эндпоинты ниже). В памяти процесса: перезапуск
  // сервера обнуляет его, а сиротевший npm при этом дособирает сам — dist не портится.
  let webRebuild: WebRebuildState | null = null;
  const rebuildBusy = () => webRebuild?.status === 'running';
  const rebuildConflict = (reply: FastifyReply) => reply.code(409).send({
    error: 'rebuild_in_progress',
    message: 'Идёт пересборка web-бандла — дождитесь её конца.',
  });
  fastify.get('/api/system', async () => system.read());

  // GET принципиально локальный: HEAD/status + сохранённый результат последней remote-
  // проверки. Сеть разрешена только явному POST и редкому фоновому таймеру.
  fastify.get('/api/system/version', async () => {
    const status = await releases.getStatus();

    return packaged ? {
      ...status,
      job: await updates.getJob()
    } : status;
  });
  fastify.post('/api/system/version/check', async () => {
    const status = await releases.checkRemote();

    if (packaged && typeof status === 'object' && status !== null) {
      return {
        ...status,
        job: await updates.getJob()
      };
    }

    return status;
  });
  fastify.post<PackageUpdateRoute>('/api/system/package-update', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['expectedVersion', 'expectedArchiveSha256'],
        propertyNames: { enum: ['expectedVersion', 'expectedArchiveSha256'] },
        properties: {
          expectedVersion: {
            type: 'string',
            pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'
          },
          expectedArchiveSha256: {
            type: 'string',
            pattern: '^[0-9a-f]{64}$'
          },
        },
      },
    },
  }, async (request, reply) => {
    if (!packaged) {
      return packageRequired(reply);
    }
    try {
      const job = await updates.startPackageUpdate(request.body);

      return reply.code(202).send({
        ok: true,
        job
      });
    } catch (error) {
      return sendReleaseError(reply, error);
    }
  });

  fastify.get('/api/system/update-job', async () => ({ job: await updates.getJob() }));

  /**
   * Отказ релиза наружу. Чужую ошибку не переодеваем в 4xx: без кода и статуса это
   * сбой, а не решение, и он обязан долететь до общего обработчика как есть.
   */
  function sendReleaseError(reply: FastifyReply, thrown: unknown) {
    const error = thrown as ReleaseError | null;

    if (!error?.statusCode || !error?.code) throw thrown;

    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }

  /**
   * Перезапуск после обновления пакета: desktop — выход 75 для приложения-владельца,
   * systemd — штатный слив (юнит поднимет). Ручной режим не вызывает скрипт: задание
   * остаётся restarting, перезапуск подтверждает человек.
   */
  function schedulePackageRestart() {
    const mode = serverMode();

    // Разорванный владелец не поднимет процесс после кода 75: задание остаётся
    // в restarting и подтверждается следующим запуском человека.
    if (mode === 'manual' || (mode === 'desktop' && !opts.desktop?.connected)) {
      return;
    }

    setTimeout(() => {
      if (mode === 'desktop') {
        void fastify.shutdown!.begin('обновление пакета', DESKTOP_RESTART_EXIT_CODE);

        return;
      }
      if (fastify.shutdown) {
        void fastify.shutdown.begin('обновление пакета');
      } else {
        process.exit(0);
      }
    }, 400);
  }

  fastify.post<ApplyRoute>('/api/system/apply', {
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
    if (packaged) {
      return packageRequired(reply);
    }

    // Гонка с пересборкой web: worker обновления публикует dist атомарным rename,
    // а бегущий vite build писал бы в него поверх старых исходников — мешанина.
    if (rebuildBusy()) return rebuildConflict(reply);
    try {
      const job = await updates.startApply(request.body);
      return reply.code(202).send({ ok: true, job });
    } catch (error) { return sendReleaseError(reply, error); }
  });

  fastify.post<UpdateRoute>('/api/system/update', {
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
    if (packaged) {
      return packageRequired(reply);
    }

    if (rebuildBusy()) return rebuildConflict(reply);
    try {
      const job = await updates.startUpdate(request.body);
      return reply.code(202).send({ ok: true, job });
    } catch (error) { return sendReleaseError(reply, error); }
  });

  // Режим запуска — для блока «Сервер» в настройках.
  fastify.get('/api/system/server', async () => {
    const mode = serverMode();

    return {
      systemd: mode === 'systemd',
      mode,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    };
  });

  // Перезапуск сервера. Ответ уходит ДО остановки (задержка), иначе кнопка не узнает,
  // что нажалась. Все режимы идут через координатор остановки (lib/shutdown.ts): чат
  // сначала даёт ходам закончиться и прерывает остальные с сохранением ленты и id сессии,
  // и только потом процесс выходит. Под systemd этого достаточно: юнит с Restart=always
  // поднимет чистую копию и подтянет новый код после деплоя. При ручном запуске поднимать
  // некому, поэтому deploy/restart.sh отвязанным процессом (переживает смерть родителя:
  // detached здесь + setsid внутри самого скрипта); он шлёт SIGTERM и ждёт освобождения
  // порта, а слив запускает уже обработчик сигнала. РЕЖИМЫ НЕ СМЕШИВАЕМ: deploy/restart.sh под
  // systemd поднял бы второй экземпляр против юнита и отправил service в бесконечный
  // restart loop (см. комментарий в deploy/grigdesk-server.service).
  fastify.post('/api/system/restart', async (_request, reply) => {
    // Рестарт гасит процесс → статус пересборки (в памяти) потеряется, а клиент
    // останется ждать. Проще запретить, чем восстанавливать неизвестное состояние.
    if (rebuildBusy()) {
      return rebuildConflict(reply);
    }

    try {
      await updates.assertIdle();
    } catch (error) {
      return sendReleaseError(reply, error);
    }

    const mode = serverMode();

    if (mode === 'desktop' && !opts.desktop?.connected) {
      return reply.code(503).send({
        error: 'desktop_parent_unavailable',
        message: 'Приложение GrigDesk не на связи.',
      });
    }

    setTimeout(() => {
      if (mode === 'desktop') {
        void fastify.shutdown!.begin('кнопка «Перезапустить»', DESKTOP_RESTART_EXIT_CODE);

        return;
      }

      if (mode === 'systemd') {
        if (fastify.shutdown) {
          void fastify.shutdown.begin('кнопка «Перезапустить»');
        } else {
          process.exit(0);
        }
        return;
      }

      restartScript(config.rootDir);
    }, 400);

    return {
      ok: true,
      mode: mode === 'manual' ? 'script' : mode,
    };
  });

  fastify.post<UpdateRestartRoute>('/api/system/update-restart', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['jobId'],
        propertyNames: { enum: ['jobId'] },
        properties: {
          jobId: {
            type: 'string',
            pattern: '^[0-9a-f-]{36}$',
          },
        },
      },
    },
  }, async (request, reply) => {
    if (request.authKind !== 'cli') {
      return reply.code(403).send({ error: 'cli_token_required' });
    }

    if (serverMode() !== 'desktop') {
      return reply.code(409).send({ error: 'not_desktop_mode' });
    }

    if (!opts.desktop?.connected) {
      return reply.code(503).send({ error: 'desktop_parent_unavailable' });
    }

    if (!await updates.isRestarting(request.body.jobId)) {
      return reply.code(409).send({ error: 'update_job_mismatch' });
    }

    if (fastify.shutdown?.active) {
      return reply.code(202).send({
        ok: true,
        already: true,
      });
    }

    setTimeout(() => {
      void fastify.shutdown!.begin('обновление GrigDesk', DESKTOP_RESTART_EXIT_CODE);
    }, 400);

    return reply.code(202).send({ ok: true });
  });

  // ── Автозапуск и ярлык GrigDesk ──
  // Механизм остаётся systemd (надзор, ворота VPN, старт до входа через linger); здесь
  // только продуктовая ручка над ним и ярлык через deploy/shortcut.sh.
  const launcher = opts.launcher || new LauncherService({ rootDir: config.rootDir });

  /**
   * Отказ лаунчера наружу со своим статусом; чужая ошибка уходит общему обработчику как есть.
   */
  function sendLauncherError(reply: FastifyReply, thrown: unknown) {
    if (!(thrown instanceof LauncherError)) throw thrown;

    return reply.code(thrown.statusCode).send({ error: thrown.code, message: thrown.message });
  }

  fastify.get('/api/system/launcher', async () => launcher.readState());

  fastify.put<AutostartRoute>('/api/system/launcher/autostart', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['enabled'],
        propertyNames: { enum: ['enabled'] },
        properties: { enabled: { type: 'boolean' } },
      },
    },
  }, async (request, reply) => {
    try {
      return { autostart: await launcher.setAutostart(request.body.enabled) };
    } catch (error) { return sendLauncherError(reply, error); }
  });

  fastify.post('/api/system/launcher/shortcut', async (_request, reply) => {
    try {
      return { shortcut: await launcher.installShortcut() };
    } catch (error) { return sendLauncherError(reply, error); }
  });

  fastify.delete('/api/system/launcher/shortcut', async (_request, reply) => {
    try {
      return { shortcut: await launcher.removeShortcut() };
    } catch (error) { return sendLauncherError(reply, error); }
  });

  // ── Пересборка web-бандла из текущего рабочего дерева ──
  // Лёгкий путь рядом с полным «применить checkout» (updates): без git-preflight,
  // временного снимка, smoke-тестов и перезапуска — npm install + vite build прямо
  // в web/. В сборку попадают и незакоммиченные правки (типовой случай: подправил
  // фронт и хочешь увидеть живьём). dist — статика, серверу перезапуск не нужен.
  function runNpm(args: string[]) {
    return new Promise<{ code: number; timedOut: boolean; output: string }>((resolve) => {
      execFile('npm', args, {
        cwd: path.join(config.rootDir, 'web'),
        timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout = '', stderr = '') => resolve({
        code: error ? (Number.isInteger(error.code) ? Number(error.code) : 1) : 0,
        timedOut: !!error?.killed,
        output: `${stdout}\n${stderr}`,
      }));
    });
  }

  // Хвост вывода npm для сообщения об ошибке: полный лог мегабайты, а причина — внизу.
  function outputTail(text: unknown) {
    return String(text || '').split('\n').map((line) => line.trimEnd()).filter(Boolean)
      .slice(-8).join('\n').slice(-600);
  }

  async function rebuildWebBundle(): Promise<RebuildFailure | null> {
    // `--include=dev` обязателен. Юнит GrigDesk ставит NODE_ENV=production, а `npm
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
    if (packaged) {
      return packageRequired(reply);
    }

    try { await updates.assertIdle(); }
    catch (error) { return sendReleaseError(reply, error); }
    if (rebuildBusy()) return rebuildConflict(reply);
    const started: WebRebuildState = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };

    webRebuild = started;
    // Сборка ~минута — дольше таймаутов гейтвея, поэтому фоном, а клиент опрашивает GET.
    Promise.resolve()
      .then(() => webRebuilder())
      .then((failure) => {
        webRebuild = {
          ...started, status: failure ? 'failed' : 'done',
          finishedAt: new Date().toISOString(), error: failure || null,
        };
      })
      .catch((error: unknown) => {
        webRebuild = {
          ...started, status: 'failed', finishedAt: new Date().toISOString(),
          error: {
            code: 'rebuild_failed',
            message: (error as Error)?.message || 'Пересборка неожиданно завершилась.',
          },
        };
      });
    return reply.code(202).send({ ok: true });
  });

  await updates.recover?.();
  releases.start?.();

  fastify.addHook('onClose', async () => { releases.stop?.(); });
}

/**
 * Общие ранние ворота source-мутаций не вызывают менеджер или npm.
 * UI получает тот же код, что и прямой вызов packaged-менеджера.
 */
function packageRequired(reply: FastifyReply) {
  return reply.code(409).send({ error: PACKAGE_UPDATE_ERROR, message: PACKAGE_UPDATE_MESSAGE });
}

export default fp(systemModule, { name: 'module-system' });
