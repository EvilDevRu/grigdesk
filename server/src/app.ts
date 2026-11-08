import './startDataHome.ts';
import { createHelpService } from './lib/help/service.ts';
import helpModule from './modules/help/index.ts';
import { runtimeKind } from './lib/runtimePaths.ts';
import { GrigdeskTaskStore } from './lib/grigdeskTasks/store.ts';
// Ядро сервера GrigDesk. Явная сборка: конфиг → адаптеры → плагины → модули → listen.
// Никакой автозагрузки (YAGNI): модули регистрируются списком, зависимости передаём явно.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';

import { isProjectDeleted, deletedProjectIds } from './lib/projects/deletion.ts';
import { assertSupportedNode } from './lib/nodeVersion.ts';
import { createShutdownCoordinator } from './lib/shutdown.ts';
import { attachDesktopParent } from './lib/desktopParent.ts';
import type { DesktopParent } from './lib/desktopParent.ts';
import { config } from './config.ts';
import { MobileService } from './lib/mobile/service.ts';
import { ensureBrainIdentity } from './lib/mobile/identity.ts';
import { startClientListener } from './lib/clientAccess/listener.ts';
import type { ClientListener } from './lib/clientAccess/listener.ts';
import { createClientBootstrap, registerClientPairRoute } from './lib/clientAccess/bootstrap.ts';
import devicesModule from './modules/devices/index.ts';
import { ActionTokens } from './lib/mobile/actionTokens.ts';
import { recoverChatOperation } from './lib/mobile/chatTurns.ts';
import { registerMobileFacade } from './lib/mobile/facade/index.ts';
import { relayVpnGate } from './lib/mobile/vpn.ts';
import mobileModule from './modules/mobile/index.ts';
import { grigDeskCliPath } from './lib/cliPath.ts';
import { AuthStore } from './lib/authStore.ts';
import { registerWindowKeyLifecycle } from './lib/windowKey.ts';
import type { WindowAuthState } from './lib/windowKey.ts';
import { windowKeyPath } from '../../shared/desktop/windowKeyPath.ts';
import { FactoryStateAdapter } from './adapters/factoryState.ts';
import { ArbiterCardsStore } from './lib/arbiterCards.ts';
import { ArbiterConversationStore } from './lib/arbiterConversationStore.ts';
import { createTrackerRuntime } from './lib/trackers/runtime.ts';
import trackersModule from './modules/trackers/index.ts';
import { SystemAdapter } from './adapters/system.ts';
import { MediaAdapter } from './adapters/media.ts';
import { extractSceneFrames } from './lib/media/ingest.ts';
import { TrackerCredentialsStore } from './lib/trackers/credentialsStore.ts';
import { ClaudeAuthStore } from './lib/claudeAuthStore.ts';
import { PrefsStore } from './lib/prefsStore.ts';
import { PluginInstallService } from './lib/packageInstall/service.ts';
import { createDbEngineInstallRuntime } from './lib/db/installRuntime.ts';
import {
  readDbEngineInstallConfiguration, readPluginInstallConfiguration,
} from './lib/packageInstall/configuration.ts';
import { SYSTEM } from './lib/pluginsRegistry.ts';
import { SpeechRuntime } from './lib/speech/index.ts';
import { SpeechInstallationService } from './lib/speech/installation.ts';
import { ModelJobManager } from './lib/speech/modelJobs.ts';
import { listProjects } from './lib/profiles.ts';
import { installBundledSkills } from './lib/skills/bundledSkills.ts';
import * as telegramBotApi from './lib/telegram/api.ts';
import { TelegramAccountBindings } from './lib/telegram/accountBindings.ts';
import { createTelegramAccountContextFactory } from './lib/telegram/accountContext.ts';
import { TelegramAccountPoller } from './lib/telegram/accountPoller.ts';
import { TelegramConnection } from './lib/telegram/connection.ts';
import { TelegramCredentialsStore } from './lib/telegram/credentialsStore.ts';
import { createTelegramInboxChannel } from './lib/telegram/inboxChannel.ts';
import { TelegramPultActions } from './lib/telegram/pult/actions.ts';
import { TelegramPultStateStore } from './lib/telegram/pult/stateStore.ts';
import { TelegramPultWatch } from './lib/telegram/pult/watch.ts';
import { PultSendQueue } from './lib/telegram/pult/sendQueue.ts';
import { GitHubAccountBindings } from './lib/github/accountBindings.ts';
import { createGitHubAccountContextFactory } from './lib/github/accountContext.ts';
import { GitHubConnection } from './lib/github/connection.ts';
import { GitHubCredentialsStore } from './lib/github/credentialsStore.ts';
import { createGitHubInboxChannel } from './lib/github/inboxChannel.ts';
import { INBOX_REF_LIMITS } from './lib/inbox/identity.ts';
import { InboxCoordinator } from './lib/inbox/coordinator.ts';
import { InboxAttachmentAnalyzer } from './lib/inbox/attachmentAnalysis.ts';
import { InboxTaskService } from './lib/inbox/taskService.ts';
import { InboxAutoTasks } from './lib/inbox/autoTasks.ts';
import { FactoryArbiterWatch } from './lib/factoryArbiterWatch.ts';
import { FactoryArbiterLive } from './lib/factoryArbiterLive.ts';
import { runInboxTriage } from './lib/inbox/triage.ts';
import { FactoryDebugSettings } from './lib/factoryDebug.ts';
import { DiagnosticLoggingPolicy, serverLogLevel } from './lib/diagnosticLogging.ts';
import { installHttpDiagnostics } from './lib/httpDiagnostics.ts';
import { createRuntimeDiagnostics } from './lib/runtimeDiagnostics.ts';
import { readRouteWorkTime } from './lib/factoryRouteCli.ts';
import { TaskFavoritesStore } from './lib/taskFavoritesStore.ts';
import { TaskFavoritesService } from './lib/taskFavoritesService.ts';
import { TaskShelfStore } from './lib/taskShelfStore.ts';
import { TaskShelfService } from './lib/taskShelfService.ts';
import { TaskSeenStore } from './lib/taskSeenStore.ts';
import { TaskSeenService } from './lib/taskSeenService.ts';
import { createPermissionQueue } from './lib/chat/permissionQueue.ts';
import { createSshStore } from './lib/ssh/store.ts';
import { createHostKeyStore } from './lib/ssh/hostKeys.ts';
import { createSshTransport } from './lib/ssh/transport.ts';
import { createSshSessionManager } from './lib/ssh/sessionManager.ts';
import { createSshAudit } from './lib/ssh/audit.ts';
import { createSshBroker } from './lib/ssh/broker.ts';
import { createEngineRegistry } from './lib/db/engineRegistry.ts';
import { createDbStore } from './lib/db/store.ts';
import { createDbSessionManager } from './lib/db/sessionManager.ts';
import { createDbAudit } from './lib/db/audit.ts';
import { createDbBroker } from './lib/db/broker.ts';
import { createHumanDbQueries } from './lib/db/humanQueries.ts';
import type { DbQueryRecord } from './lib/db/humanQueries.ts';
import type { LimitedDbResult } from './lib/db/result.ts';
import type { FactoryModuleOptions } from './modules/factory/index.ts';
import type { MediaModuleOptions } from './modules/media/index.ts';
import type { GitHubModuleOptions } from './modules/github/index.ts';
import type { TelegramModuleOptions } from './modules/telegram/index.ts';
import type { SshModuleOptions } from './modules/ssh/index.ts';
import type { SettingsModuleOptions } from './modules/settings/index.ts';
import { normalizeDbResult } from './lib/db/result.ts';
import { createDockerService } from './lib/docker/service.ts';
import { createSandboxActivityGuard } from './lib/sandboxes/activityGuard.ts';
import { createSandboxService } from './lib/sandboxes/service.ts';
import { createShowcaseService } from './lib/showcase/service.ts';
import { resolveInboxTriageTarget } from './lib/inbox/triage.ts';

import apiVersionPlugin from './plugins/apiVersion.ts';
import authPlugin from './plugins/auth.ts';
import ssePlugin from './plugins/sse.ts';
import webLogModule from './modules/web-log/index.ts';
import { createApiRouteRegistry } from './lib/webLog/apiRoutes.ts';
import staticPlugin from './plugins/static.ts';

import healthModule from './modules/health/index.ts';
import factoryModule from './modules/factory/index.ts';
import trackerModule from './modules/tracker/index.ts';
import grigdeskTasksModule from './modules/grigdesk-tasks/index.ts';
import taskFavoritesModule from './modules/task-favorites/index.ts';
import taskShelfModule from './modules/task-shelf/index.ts';
import taskSeenModule from './modules/task-seen/index.ts';
import systemModule from './modules/system/index.ts';
import mediaModule from './modules/media/index.ts';
import chatModule from './modules/chat/index.ts';
import settingsModule from './modules/settings/index.ts';
import terminalModule from './modules/terminal/index.ts';
import routesModule from './modules/routes/index.ts';
import providersModule from './modules/providers/index.ts';
import usageForecastModule from './modules/usage-forecast/index.ts';
import analysisModule from './modules/analysis/index.ts';
import authModule from './modules/auth/index.ts';
import pluginsModule from './modules/plugins/index.ts';
import { createPluginRuntimeServices } from './modules/plugins/runtimeServices.ts';
import { createPluginEnvironment } from './lib/pluginEnvironment.ts';
import { SESSION_ONLY_PREFIXES } from './modules/plugins/installRoutes.ts';
import pluginCatalogModule from './modules/plugin-catalog/index.ts';
import { PluginCatalogService } from './lib/pluginCatalog.ts';
import projectsModule from './modules/projects/index.ts';
import { createProjectsService } from './modules/projects/service.ts';
import {
  countGitHubRules,
  countTelegramRules,
} from './lib/projects/dependencySources.ts';
import { isProjectArchived } from './lib/projects/archive.ts';
import { projectRepos } from './lib/projects.ts';
import { RoutesStore } from './modules/routes/store.ts';
import { createFactoryBrowserTrusted } from './lib/browser/factoryBrowserTrusted.ts';
import { createBrowserService } from './lib/browser/browserService.ts';
import browserModule from './modules/browser/index.ts';
import codeModule from './modules/code/index.ts';
import telegramModule from './modules/telegram/index.ts';
import githubModule from './modules/github/index.ts';
import inboxModule from './modules/inbox/index.ts';
import documentsModule from './modules/documents/index.ts';
import sshModule from './modules/ssh/index.ts';
import dbModule from './modules/db/index.ts';
import dockerModule from './modules/docker/index.ts';
import sandboxesModule from './modules/sandboxes/index.ts';
import showcaseModule from './modules/showcase/index.ts';
import { Analyzer } from './lib/analysis/analyzer.ts';
import { AnalysisArbiter } from './lib/analysis/arbiter.ts';
import { DocumentReader } from './lib/documents/reader.ts';

// npm start и существующий systemd-юнит тоже дают агентам CLI текущей установки.
// Дочерние процессы наследуют этот PATH независимо от рабочего каталога задачи.
process.env.PATH = grigDeskCliPath(config.rootDir, process.env.PATH, config.installationBin);

// Общие настройки передаются сервисам из одного хранилища.
// Чтение не изменяет сохранённые настройки этой установки.
const prefs = new PrefsStore({ prefsPath: config.prefsPath });

/**
 * Соединение готовой службы с портом модуля.
 *
 * Модуль объявляет ПОРТ — ровно то, что читает сам, — и структурно он не всегда совпадает
 * с классом службы: у порта бывает индексная сигнатура (`Record<string, unknown>`), которой
 * у класса нет, а класс возвращает типы уже тех, что объявил порт. Оба расхождения
 * безопасны и закрыты тестами самих модулей, поэтому приведение живёт здесь — в единственной
 * точке сборки — и нигде больше. Раздел 7 плана заменяет такие порты настоящими типами.
 */
function asPort<Port>(service: unknown): Port {
  return service as Port;
}

// Настройки плагина недоверенные: их форму объявляет сам раздел, а сюда они приходят
// как `unknown`. Общий помощник даёт словарь — приведение остаётся на месте чтения.
function readPluginSettings(
  fastify: FastifyInstance,
  id: string,
): Record<string, unknown> {
  return (fastify.pluginSettings?.(id) || {}) as Record<string, unknown>;
}

/**
 * Пути installer и VERSION проверяются до создания ресурсов приложения.
 * Закрытие Fastify ждёт installer lifetime прежде завершения процесса.
 */
async function build(desktopParent: DesktopParent | null) {
  const installOptions = await readPluginInstallConfiguration(config);
  const dbInstallOptions = await readDbEngineInstallConfiguration(config);
  const factoryDebug = new FactoryDebugSettings({
    factoryBin: config.factoryBin,
    stateDir: config.stateDir,
    configRoot: config.factoryConfigRoot,
    profilesDir: config.profilesDir,
  });
  const diagnosticLogging = new DiagnosticLoggingPolicy(factoryDebug);
  const initialLogLevel = await diagnosticLogging.level().catch(() => 'off' as const);
  const fastify = Fastify({
    logger: { level: serverLogLevel(initialLogLevel) },
    // Дефолтного мегабайта fastify хватало ровно до того дня, когда история чатов доросла
    // до него: PUT /api/chat/store начал отвечать 413, клиент молча ретраил каждые 15 с —
    // и переписка перестала сохраняться совсем (терялась на F5 и «стопе»). Тело чатов
    // теперь режется на отдельные запросы (store/chat), а этот лимит — общая страховка.
    bodyLimit: 64 * 1024 ** 2,
    // Дефолтные 100 символов на :param — это ровно вдвое меньше обычного Inbox ref
    // (`/api/inbox/items/:ref/dismiss`, ~220 символов base64url). Роутер отвечал 414
    // FST_ERR_MAX_PARAM_LENGTH раньше любого обработчика, поэтому ручные «Поставить
    // задачу», «Пропустить» и «Вернуть на разбор» не работали вовсе, а автомат — работал
    // (он ходит внутри процесса, мимо HTTP). Потолок берётся у кодека refs
    // (`INBOX_REF_LIMITS.encodedChars`), чтобы предела правды не было два.
    maxParamLength: INBOX_REF_LIMITS.encodedChars,
    // На остановке рвём все соединения разом: поток SSE и вебсокеты — незавершённые
    // ответы, и `server.close()` ждал бы их вечно. К этому моменту слив уже прошёл, и
    // долгих запросов, которым есть что терять, на сервере нет.
    forceCloseConnections: true,
    // Дефолтных 10 с на старт модуля не хватает чату с большой историей: сервер падал
    // на AVV_ERR_PLUGIN_EXEC_TIMEOUT и уходил в бесконечный цикл перезапусков systemd.
    pluginTimeout: 60_000,
  });

  // Встроенные навыки комплекта зеркалируются в ~/.agents/skills при каждом старте: только
  // этот каталог знают меню «/» и файловый provider Harness. Сбой синка не мешает подъёму.
  const bundledSkills = await installBundledSkills().catch(() => [] as string[]);

  if (bundledSkills.length > 0) {
    fastify.log.info({ skills: bundledSkills }, 'Встроенные навыки синхронизированы в ~/.agents/skills');
  }

  await fastify.register(apiVersionPlugin);

  const httpDiagnostics = installHttpDiagnostics(fastify);
  const runtimeDiagnostics = createRuntimeDiagnostics((data) => {
    fastify.log.debug(data, 'Ресурсы сервера');
  });

  // Журнал окна хранит пути /api шаблонами; каталог шаблонов собирается здесь,
  // до регистрации модулей, чтобы в него попал каждый маршрут сервера.
  const apiRoutes = createApiRouteRegistry();

  fastify.addHook('onRoute', (route) => apiRoutes.add(route.url));

  const stopLoggingPolicy = diagnosticLogging.subscribe((level) => {
    fastify.log.level = serverLogLevel(level);
    httpDiagnostics.reset();
    runtimeDiagnostics.setEnabled(level === 'verbose');
  });
  const loggingPolicyTimer = setInterval(() => {
    void diagnosticLogging.level().catch(() => undefined);
  }, 60_000);

  loggingPolicyTimer.unref();
  fastify.addHook('onClose', async () => {
    clearInterval(loggingPolicyTimer);
    stopLoggingPolicy();
    diagnosticLogging.close();
    runtimeDiagnostics.close();
  });
  // Остановка: модули регистрируют слив (чат прерывает ходы и сохраняет их итог), а
  // сигнал или кнопка «Перезапустить» запускают его ДО закрытия сервера. Обработчики
  // сигналов вешаются после listen — до него закрывать нечего.
  const shutdown = createShutdownCoordinator({
    close: () => fastify.close(),
    log: fastify.log,
    timeoutMs: config.shutdownTimeoutMs,
  });
  fastify.decorate('shutdown', shutdown);

  // CORS нужен только в dev (vite на другом порту). В проде фронт — тот же origin.
  if (config.isDev) {
    await fastify.register(cors, { origin: true });
  }

  // Загрузка видео/аудио для распознавания (до 3 ГБ).
  await fastify.register(multipart, { limits: { fileSize: 3 * 1024 ** 3 } });

  // WebSocket — для терминала (PTY-поток). maxPayload скромный: терминал — не файлы.
  await fastify.register(websocket, { options: { maxPayload: 1 * 1024 ** 2 } });

  // Адаптеры (изоляция источников).
  // Разбор арбитра: единственное место, где машинный вердикт узла превращается в
  // человеческую формулировку. Раньше он показывался одноразовым диалогом, а у
  // автоматического пути пропадал совсем — теперь переживает перезапуск и виден в карточке.
  const arbiterCards = new ArbiterCardsStore(config.arbiterCardsPath);
  const arbiterConversations = new ArbiterConversationStore(config.arbiterConversationsDir, (doc) => {
    fastify.sse?.broadcast?.('arbiter-conversation', {
      task: doc.identity.task,
      conversationId: doc.id,
      revision: doc.revision,
    });
  });
  // Идущий разбор виден всем окнам, а не только нажавшему кнопку: пока арбитр работает,
  // задача снаружи неотличима от вставшей, и человек берётся за неё руками. Событие шины
  // шлём ленивой ссылкой — плагин sse регистрируется позже этого места.
  const arbiterLive = new FactoryArbiterLive({
    onChange: (task) => fastify.sse?.broadcast?.('arbiter-live', { task, at: Date.now() }),
  });
  const factoryState = new FactoryStateAdapter({
    stateDir: config.stateDir,
    routesDir: config.routesDir,
    profilesDir: config.profilesDir,
    controlDir: config.factoryControlDir,
    workTimeReader: (identity) => readRouteWorkTime(config, identity),
    arbiterCards,
    arbiterConversations,
  });
  const projectsService = createProjectsService({
    config,
    prefs,
    broadcast: (event, data) => fastify.sse?.broadcast?.(event, data),
  });

  const help = createHelpService({ root: config.rootDir, kind: runtimeKind() });

  const browserAuthority = {
    controlRoot: config.factoryControlDir,
    trusted: createFactoryBrowserTrusted({
      state: factoryState,
      routes: new RoutesStore({ baseDir: config.routesDir }),
      projectExists: async (profile) => (await listProjects(config, prefs)).includes(profile),
    }),
  };
  const browser = await createBrowserService({
    prefs,
    dataHome: config.dataHome,
    artifactsDir: config.artifactsDir,
    authority: browserAuthority,
  });
  const removeTaskOwners = browser.owners.register('task', async () => {
    const rows: { owner: string; label: string }[] = [];

    for (const task of (await factoryState.listTaskIds()).slice(0, 1000)) {
      const trusted = await browserAuthority.trusted(task).catch(() => null);

      if (trusted) {
        rows.push({
          owner: JSON.stringify(['task', trusted.profile, task, trusted.attempt]),
          label: `Задача ${task}`,
        });
      }
    }

    return rows;
  });

  fastify.addHook('onClose', async () => {
    removeTaskOwners();
    await browser.close();
  });

  const isDeletedProject = (id: string) => isProjectDeleted(prefs, id);
  const permissionQueue = createPermissionQueue();
  const sshConnections = await createSshStore({
    withReferences: projectsService.withReferences,
    isProjectDeleted: isDeletedProject,
    file: config.sshConnectionsPath,
    projects: async () => (await listProjects(config, prefs)).map((id) => ({ id })),
  });
  const sshHostKeys = await createHostKeyStore({ file: config.sshKnownHostsPath });
  const sshTransport = createSshTransport();
  const sshSessions = createSshSessionManager({
    transport: sshTransport,
    // Эхо агентских команд в терминал человека — видимость происходящего, а не канал
    // исполнения; выключается настройкой плагина без перезапуска сервера.
    echoEnabled: () => readPluginSettings(fastify, 'ssh').echoToTerminal !== false,
  });
  const sshAuditStore = await createSshAudit({ dir: config.sshAuditDir });
  const sshAudit = {
    async append(entry: Parameters<typeof sshAuditStore.append>[0]) {
      const result = await sshAuditStore.append(entry);
      fastify.sse?.broadcast?.('ssh-audit', { at: result.at });
      return result;
    },
  };
  const sshBroker = createSshBroker({
    pluginEnabled: (id) => fastify.pluginEnabled?.(id) === true,
    sessions: sshSessions,
    permissionQueue,
    audit: sshAudit,
    outputLimitBytes: () => (
      Math.max(4, Math.min(1_024, Number(readPluginSettings(fastify, 'ssh').outputLimitKiB) || 64))
      * 1_024
    ),
  });
  fastify.decorate('sshBroker', sshBroker);

  sshSessions.subscribe((event) => {
    if (event.type === 'lost' || (event.type === 'access' && !event.session.agentAllowed)) {
      permissionQueue.cancelWhere(
        (entry) => entry.origin === 'ssh' && entry.sessionId === event.session.id,
        { allow: false, error: event.type === 'lost' ? 'session_lost' : 'access_revoked' },
      );
    }
    fastify.sse?.broadcast?.('ssh-sessions', { sessionId: event.session.id });
  });

  const sshService = {
    listConnections: () => sshConnections.list(),
    createConnection: (input: Parameters<typeof sshConnections.create>[0]) => (
      sshConnections.create(input)
    ),
    updateConnection: (
      id: string,
      input: Parameters<typeof sshConnections.update>[1],
    ) => sshConnections.update(id, input),
    async deleteConnection(id: string) {
      await Promise.all(sshSessions.list()
        .filter((session) => session.connectionId === id)
        .map((session) => sshSessions.close(session.id)));
      return sshConnections.remove(id);
    },
    async probeHostKey(id: string) {
      const connection = sshConnections.get(id);
      if (!connection) {
        throw Object.assign(new Error('SSH-соединение не найдено'), { code: 'not_found' });
      }
      const probed = await sshTransport.probe(connection);

      if (!probed) {
        throw Object.assign(new Error('Сервер не показал host key'), { code: 'probe_failed' });
      }

      return sshHostKeys.check(probed);
    },
    decideHostKey: (
      challengeId: string,
      decision: Parameters<typeof sshHostKeys.decide>[1],
    ) => sshHostKeys.decide(challengeId, decision),
    async openSession(id: string, password?: string) {
      const connection = sshConnections.get(id);
      if (!connection) {
        throw Object.assign(new Error('SSH-соединение не найдено'), { code: 'not_found' });
      }
      const trusted = sshHostKeys.get(connection.host, connection.port);
      if (!trusted) {
        throw Object.assign(new Error('Сначала подтвердите host key'), { code: 'trust_required' });
      }
      const session = await sshSessions.open({
        connection,
        password: password ?? '',
        hostVerifier: (fingerprint: string) => fingerprint === trusted.fingerprint,
      });
      return { session };
    },
    listSessions: () => sshSessions.list(),
    setAgentAccess: (id: string, allowed: boolean) => sshSessions.setAgentAccess(id, allowed),
    closeSession: (id: string) => sshSessions.close(id),
    attachTerminal: (
      id: string,
      socket: Parameters<typeof sshSessions.attach>[1],
    ) => sshSessions.attach(id, socket),
    writeTerminal: (id: string, data: string) => sshSessions.write(id, data),
    resizeTerminal: (id: string, cols: number, rows: number) => sshSessions.resize(id, cols, rows),
    listFiles: (id: string, remotePath: string) => sshSessions.listFiles(id, remotePath),
    downloadFile: (id: string, remotePath: string) => sshSessions.downloadFile(id, remotePath),
    async uploadFile(id: string, request: { file: () => Promise<{
      fields?: Record<string, { value?: unknown } | undefined>;
      filename?: string;
      file: NodeJS.ReadableStream;
    } | null> }) {
      const part = await request.file();
      if (!part) {
        throw Object.assign(new Error('Файл не передан'), { code: 'invalid_connection' });
      }
      const remotePath = String(part.fields?.path?.value || part.filename || '');
      return sshSessions.uploadFile(id, remotePath, part.file);
    },
    listAudit: (query: Parameters<typeof sshAuditStore.list>[0]) => sshAuditStore.list(query),
    answerApproval: (
      pid: string,
      body: Parameters<typeof permissionQueue.answer>[2],
    ) => permissionQueue.answer(pid, 'ssh', body),
    async disable() {
      permissionQueue.cancelWhere(
        (entry) => entry.origin === 'ssh',
        { allow: false, error: 'plugin_disabled' },
      );
      await sshSessions.closeAll('plugin_disabled');
    },
  };

  const builtinEngines = await createEngineRegistry();
  const builtinList = await builtinEngines.list();
  const dbEngineInstalls = new PluginInstallService({
    ...dbInstallOptions,
    packageKind: 'db-engine',
    reservedIds: builtinList.map((engine) => engine.id),
    log: fastify.log,
  });

  fastify.addHook('onClose', async () => dbEngineInstalls.close());

  const dbRecovery = await dbEngineInstalls.recover();
  const dbEngines = await createEngineRegistry({
    loaders: builtinList.map((engine) => ({
      name: engine.id,
      load: async () => ({ default: builtinEngines.get(engine.id) }),
    })),
    externalDir: config.dbEnginesDir,
    blockedIds: dbRecovery.blockedIds,
    grigDeskVersion: dbInstallOptions.grigDeskVersion,
    log: fastify.log,
  });
  const dbProfiles = await createDbStore({
    withReferences: projectsService.withReferences,
    isProjectDeleted: isDeletedProject,
    path: config.dbProfilesPath,
    projects: async () => (await listProjects(config, prefs)).map((id) => ({ id })),
  });
  const dbAuditStore = await createDbAudit({ dir: config.dbAuditDir });
  const dbAudit = {
    async append(entry: Parameters<typeof dbAuditStore.append>[0]) {
      const result = await dbAuditStore.append(entry);
      fastify.sse?.broadcast?.('db-audit', { at: result.at });
      return result;
    },
  };
  const dbSessions = createDbSessionManager({
    engines: dbEngines,
    // Менеджер спрашивает у соседей МЕТОДЫ, а не поля: у ssh-сессий две исторические формы
    // проброса, очередь разрешений подключается не всегда. Поэтому его порт объявлен
    // словарём, а приведение — одно и ровно здесь, в точке соединения.
    sshSessions: sshSessions as unknown as Record<string, unknown>,
    permissionQueue: permissionQueue as unknown as Record<string, unknown>,
    idleMs: () => (
      Math.max(1, Number(readPluginSettings(fastify, 'db').idleCloseMinutes) || 15) * 60_000
    ),
  });

  dbEngineInstalls.bindRuntime(createDbEngineInstallRuntime({ sessions: dbSessions, engines: dbEngines }));

  const dbSettings = () => {
    const value = readPluginSettings(fastify, 'db');
    return {
      allowDdlAdmin: value.allowDdlAdmin === true,
      autoRead: value.autoRead === true,
      autoReadProd: value.autoReadProd === true,
      maxRows: Math.max(1, Number(value.maxRows) || 1000),
      maxBytes: Math.max(4, Number(value.maxBytesKiB) || 256) * 1024,
      timeoutMs: Math.max(1, Number(value.timeoutSeconds) || 15) * 1000,
      autoReadPerMinute: Math.max(1, Number(value.autoReadPerMinute) || 10),
    };
  };
  // Докер читает свои настройки при каждом обращении: предохранители (тома, массовая
  // очистка образов) должны действовать сразу после переключения галки, без рестарта.
  const dockerService = createDockerService({
    settings: () => {
      const value = readPluginSettings(fastify, 'docker');
      return {
        allowVolumeRemoval: value.allowVolumeRemoval === true,
        allowImagePruneAll: value.allowImagePruneAll === true,
        allowExec: value.allowExec !== false,
        logTailLines: Math.max(50, Number(value.logTailLines) || 500),
      };
    },
  });

  // Песочницы: подъём и снос идут отдельными процессами и переживают перезапуск
  // сервера, поэтому служба живёт весь его срок и сама доводит журнал до правды.
  const sandboxActivityGuard = createSandboxActivityGuard({ stateDir: config.stateDir });
  const sandboxService = createSandboxService({
    stateDir: config.stateDir,
    journalDir: config.sandboxJournalDir,
    profilesDir: config.profilesDir,
    factoryBin: config.factoryBin,
    manualRange: config.sandboxManualRange,
    sandboxActivityGuard,
    // Архивный проект новых стендов не поднимает: уже поднятый сносится как обычно.
    isProjectDeleted: (id: string) => isDeletedProject(id),
    deletedProjectIds: () => deletedProjectIds(prefs),
    isProjectArchived: (id: string) => isProjectArchived(prefs, id),
    downCmd: config.sandboxDownCmd,
    log: fastify.log,
    broadcast: (event: string, data?: unknown) => fastify.sse?.broadcast?.(event, data),
    // Шаги подъёма ловит общий вотчер каталога состояния, а не второй наблюдатель.
    subscribe: (listener: (name: string, payload?: unknown) => void) => (
      fastify.sse?.subscribe?.(listener) ?? (() => {})
    ),
  });




  // Живой запрос к БД. Хранится в памяти процесса: перезапуск обнуляет ленту, и это
  // честно — сессии БД его тоже не переживают.
  const dbQueries = new Map<string, DbQueryRecord>();

  function publicDbQuery(query: DbQueryRecord | null | undefined) {
    return query ? {
      id: query.id,
      sessionId: query.sessionId,
      actor: query.actor,
      text: query.text,
      queryClass: query.queryClass || null,
      tables: query.tables || [],
      state: query.state,
      error: query.error || null,
      startedAt: query.startedAt,
      finishedAt: query.finishedAt || null,
      result: query.result || null,
    } : null;
  }

  function updateDbQuery(event: Partial<DbQueryRecord> & { id: string }) {
    const current = dbQueries.get(event.id);
    if (current?.state === 'cancelled' && event.state !== 'cancelled') return;
    dbQueries.set(event.id, { ...current, ...event } as DbQueryRecord);
    fastify.sse?.broadcast?.('db-queries', { queryId: event.id });
  }

  const dbBroker = createDbBroker({
    pluginEnabled: (id: string) => fastify.pluginEnabled?.(id) === true,
    sessions: dbSessions,
    engines: dbEngines,
    // Брокер спрашивает у очереди методы, а не поля, — см. соединение менеджера выше.
    permissionQueue: permissionQueue as unknown as Record<string, unknown>,
    audit: dbAudit,
    settings: dbSettings,
    onQuery: asPort(updateDbQuery),
  });
  fastify.decorate('dbBroker', dbBroker);

  dbSessions.subscribe((event) => {
    const session = event.session as { id?: unknown } | undefined;

    fastify.sse?.broadcast?.('db-sessions', { sessionId: session?.id });
  });

  const humanDbQueries = createHumanDbQueries({
    sessions: dbSessions,
    queries: dbQueries,
    settings: dbSettings,
    audit: dbAudit,
    publish: (queryId) => fastify.sse?.broadcast?.('db-queries', { queryId }),
    onAuditError: () => fastify.log.error('Не удалось записать журнал запроса БД'),
  });

  const dbService = {
    listEngines: () => dbEngines.list(),
    /**
     * Дополнительные сведения относятся только к активному startup-снимку.
     * Ошибка installer не скрывает список и не вызывает повторного импорта.
     */
    async engineSnapshot() {
      const engines = await dbEngines.list();
      const installs: Record<string, unknown> = {};

      for (const engine of engines) {
        if (!builtinEngines.get(engine.id)) {
          installs[engine.id] = await dbEngineInstalls.describe(engine.id).catch(() => null);
        }
      }

      return {
        engines,
        errors: dbEngines.errors(),
        installs,
        installHealth: dbEngineInstalls.health(),
      };
    },
    listProfiles: () => dbProfiles.list(),
    createProfile: (input: Parameters<typeof dbProfiles.create>[0]) => dbProfiles.create(input),
    updateProfile: (
      id: string,
      input: Parameters<typeof dbProfiles.update>[1],
    ) => dbProfiles.update(id, input),
    async deleteProfile(id: string) {
      await Promise.all(dbSessions.list().filter((session) => session.profileId === id)
        .map((session) => dbSessions.close(session.id, 'profile_deleted')));
      return dbProfiles.remove(id);
    },
    async openSession(id: string, password?: string, sshSessionId?: string) {
      const profile = dbProfiles.get(id);
      if (!profile) {
        throw Object.assign(new Error('Профиль БД не найден'), { code: 'not_found' });
      }
      return { session: await dbSessions.open({ profile, password, sshSessionId }) };
    },
    listSessions: () => dbSessions.list(),
    setAgentAccess: (id: string, allowed: boolean) => dbSessions.setAgentAccess(id, allowed),
    closeSession: (id: string) => dbSessions.close(id),
    async schema(id: string) {
      const session = dbSessions.find(id);
      if (!session) {
        throw Object.assign(new Error('DB-сессия не найдена'), { code: 'session_not_found' });
      }
      // Движки лежат в runtime-реестре и объявлены словарём: конкретный класс движка
      // сюда не импортируется намеренно. Приведение — на месте вызова, как в самом менеджере.
      const readSchema = session.engine.schema as (handle: unknown) => Promise<unknown>;
      const raw = await readSchema(session.handle);
      const result = await normalizeDbResult(raw, { ...dbSettings(), completed: true });
      await dbAudit.append({
        projectId: session.profile.projectId,
        sessionId: session.id,
        actor: 'human',
        query: 'Просмотр схемы',
        queryClass: 'read',
        outcome: 'success',
        rows: result.totalRows,
        bytes: result.totalBytes,
        truncated: result.truncated,
      });
      return { schema: result };
    },
    query: humanDbQueries.query,
    listQueries: () => [...dbQueries.values()].map(publicDbQuery),
    getQuery: (id: string) => publicDbQuery(dbQueries.get(id)),
    cancelQuery: humanDbQueries.cancel,
    listAudit: (query: Parameters<typeof dbAuditStore.list>[0]) => dbAuditStore.list(query),
    answerApproval: (
      pid: string,
      body: Parameters<typeof permissionQueue.answer>[2],
    ) => permissionQueue.answer(pid, 'db', body),
    async disable() {
      permissionQueue.cancelWhere(
        (entry) => entry.origin === 'db',
        { allow: false, error: 'plugin_disabled' },
      );
      await dbSessions.closeAll('plugin_disabled');
    },
  };
  fastify.addHook('onClose', async () => dbSessions.dispose('server_shutdown'));
  fastify.addHook('onClose', async () => {
    await sshSessions.closeAll('server_shutdown');
  });

  const credsStore = new TrackerCredentialsStore({
    trackerCredentialsPath: config.trackerCredentialsPath,
  });
  const telegramBindings = new TelegramAccountBindings({
    file: path.join(config.telegramDir, 'account-bindings.json'),
  });
  const telegramCredentials = new TelegramCredentialsStore({
    file: config.telegramAccountCredsPath,
  });
  const telegramAccountContextFor = createTelegramAccountContextFactory({
    dir: config.telegramDir,
    botApi: telegramBotApi,
    // Фабрика объявляет журнал как `Console`, а Fastify отдаёт свой — совпадают ровно
    // те методы, которыми она пользуется. Приведение одно и здесь.
    log: fastify.log as unknown as Console,
  });
  const githubBindings = new GitHubAccountBindings({
    file: path.join(config.githubDir, 'account-bindings.json'),
  });
  const githubCredentials = new GitHubCredentialsStore({ file: config.githubCredsPath });
  const githubAccountContextFor = createGitHubAccountContextFactory({ dir: config.githubDir });
  const claudeAuth = new ClaudeAuthStore({ authPath: config.claudeAuthPath });
  const trackerRuntime = await createTrackerRuntime({
    config,
    traceRead: (event) => fastify.log.debug(event, 'Чтение трекера'),
    credsStore,
    factoryState,
    projectsService,
    grigDeskVersion: installOptions.grigDeskVersion,
    onChanged: async () => {
      await fastify.sse?.broadcast?.('trackers-changed', trackerRuntime.selection.read());
    },
  });
  const { tracker } = trackerRuntime;

  fastify.addHook('onClose', async () => trackerRuntime.close());
  await fastify.register(trackersModule, {
    runtime: trackerRuntime,
    driverSourcesPath: config.driverSourcesPath,
  });
  // Идентичность companion-чата можно создать и для запущенной задачи фабрики, и для
  // существующей задачи Б24 до запуска. Подтвердить её имеют право только эти
  // серверные источники.
  const companionTaskExists = async (taskId: string | number) => {
    try {
      await factoryState.readRegistry(taskId);
      return true;
    } catch { /* задача законно может существовать только в Б24 до запуска конвейера */ }

    if (!tracker.isConfigured()) {
      return false;
    }

    try {
      return Boolean(await tracker.taskDetail(taskId));
    } catch {
      return false;
    }
  };
  const speechRuntime = new SpeechRuntime({
    mediaDir: config.mediaDir,
    mediaHfDir: config.mediaHfDir,
    pythonPath: config.mediaPython,
  });
  speechRuntime.attachModelJobs(new ModelJobManager({
    jobsDir: path.join(config.mediaDir, 'model-jobs'),
    mediaHfDir: config.mediaHfDir,
    pythonPath: config.mediaPython,
    benchmarkAudioPath: config.speechBenchmarkAudioPath,
    onModelReady: () => speechRuntime.invalidateCapabilities(),
  }));
  speechRuntime.applyRuntimeSettings(prefs.read().speech as Record<string, unknown> | undefined);
  const media = new MediaAdapter({ mediaDir: config.mediaDir, speechRuntime });
  const inboxAttachmentAnalyzer = new InboxAttachmentAnalyzer({
    cacheDir: path.join(config.mediaDir, 'inbox-attachment-analysis'),
    // Расшифровка зависит от языка, модели и hotwords. При их изменении старый
    // кэш нельзя повторно использовать для новой задачи.
    revision: () => JSON.stringify(prefs.read().speech || {}),
    transcribe: asPort(({ filePath, signal }: { filePath: string; signal?: AbortSignal }) => (
      speechRuntime.transcribe({
        filePath,
        settings: prefs.read().speech as Record<string, unknown> | undefined,
        signal,
      })
    )),
    extractFrames: asPort(
      (options: Parameters<typeof extractSceneFrames>[0]) => extractSceneFrames(options),
    ),
  });
  const notifyInboxChanged = (payload?: unknown) => fastify.sse?.broadcast?.('inbox-changed', payload);
  const telegramConnection = new TelegramConnection({
    credentials: asPort(telegramCredentials),
    bindings: asPort(telegramBindings),
    accountContextFor: telegramAccountContextFor,
    botApi: telegramBotApi,
    enabled: () => fastify.pluginEnabled?.('telegram') === true,
    onChanged: notifyInboxChanged,
    log: fastify.log,
  });
  // Телеграм-пульт собирается ниже, после регистрации модулей (ему нужен inject
  // по готовым ручкам); поллер получает late-bound ссылку — сообщения и нажатия
  // начинают обрабатываться, как только runtime собран.
  // Собирается ниже, после регистрации модулей: раньше него ручек ещё нет.
  let telegramPult: {
    watch?: TelegramPultWatch;
    actions?: TelegramPultActions;
  } | null = null;
  // Одна исходящая очередь на бота: у пульта единый rate-limit domain.
  const pultQueue = new PultSendQueue();
  const telegramPoller = new TelegramAccountPoller({
    acquireLease: asPort(() => telegramConnection.acquireLease()),
    botApi: telegramBotApi,
    isEnabled: () => fastify.pluginEnabled?.('telegram') === true,
    onChanged: notifyInboxChanged,
    onMessage: (msg, type, lease) => telegramPult?.actions?.onMessage(
      msg as never,
      type as never,
      asPort(lease),
    ),
    onCallback: (callback, lease) => telegramPult?.actions?.onCallback(
      asPort(callback),
      asPort(lease),
    ),
    log: fastify.log,
  });
  telegramConnection.attachPoller(telegramPoller);

  // Презентации: раздел держит свои ролики и журнал заданий, а цель показа берёт
  // из реестра стендов и объявления профиля. Служба живёт весь срок сервера —
  // запись браузера переживает перезапуск, и журнал заданий надо сверять на старте.
  const showcaseService = createShowcaseService({
    showcaseDir: config.showcaseDir,
    authDir: config.showcaseAuthDir,
    profilesDir: config.profilesDir,
    stateDir: config.stateDir,
    browserPath: config.showcaseBrowser || null,
    browserDir: config.showcaseBrowserDir,
    voiceDir: config.showcaseVoiceDir,
    yandexVoice: {
      apiKey: config.showcaseYandexApiKey,
      folderId: config.showcaseYandexFolderId,
    },
    edgeVoice: { enabled: config.showcaseEdgeTts },
    bootstrapPython: process.env.GRIGDESK_MEDIA_BOOTSTRAP_PYTHON || 'python3',
    listProjects: () => listProjects(config, prefs),
    sandboxOverview: () => sandboxService.overview(),
    sandboxActivityGuard,
    broadcast: (event: string, data?: unknown) => fastify.sse?.broadcast?.(event, data),
    // Расшифровка для самопроверки речи идёт через общий речевой runtime GrigDesk —
    // тот же, что у диктовки и «Видео». Своей копии распознавания у раздела нет,
    // а его недоступность делает проверку пропущенной, а не проваленной.
    transcribe: async (file: string) => {
      // Showcase просит структуру один раз: тот же результат проверяет слова и
      // даёт границы для синхронизации. Обычная диктовка не включает эту опцию.
      const result = await speechRuntime.transcribe({
        filePath: file,
        settings: { ...speechRuntime.settings, wordTimestamps: true },
      }) as { transcript?: unknown };

      if (!result.transcript || typeof result.transcript !== 'object') {
        throw new Error('Распознавание не вернуло структурированную расшифровку.');
      }

      return result.transcript as import('./lib/speech/transport.ts').SpeechTranscript;
    },
    // Модель сценария — своя настройка плагина, читается перед самым вызовом:
    // смена модели действует со следующей генерации, без перезапуска. Резолвер тот
    // же, что у остальных model-only мест: он и проверяет право читать недоверенный
    // текст.
    resolveScriptModel: (input) => resolveInboxTriageTarget(input),
    scriptModelRef: () => readPluginSettings(fastify, 'showcase').scriptModel ?? null,
    // Тот же серверный config и те же настройки провайдера, что у остальных
    // model-only мест: в них лежат путь к CLI исполнителя и каталог моделей.
    executorConfig: () => config as unknown as Record<string, unknown>,
    providerSettings: () => (prefs.read().providerSettings || {}) as Record<string, unknown>,
    // Задача портала для стенда задачи: сессией владеет сервер, раздел получает
    // только текст. Портал недоступен — разбор идёт без постановки, а не падает.
    taskDetails: async (taskId: string) => await tracker.taskDetail(taskId) as {
      title?: unknown;
      description?: unknown;
    } | null,
    // Репозитории постоянного стенда — из паспорта проекта, тот же источник путей,
    // что у «Кода». Разбор читает их только по выбору человека в «О чём ролик».
    projectRepos: async (profile: string) => (await projectRepos({
      config,
      prefs,
      id: profile,
    })).map((repo) => ({ name: repo.key, path: repo.dir })),
    // Каналы доставки: сессией портала и аккаунтом Telegram владеет сервер, раздел
    // получает их готовыми и вторых не заводит.
    deliveryDeps: {
      tracker,
      telegramConnected: () => telegramConnection.connection === 'connected',
    },
    // Пределы читаются при каждом обращении: смена настройки действует со следующего
    // задания, без перезапуска сервера.
    limits: () => {
      const value = readPluginSettings(fastify, 'showcase');

      return {
        maxScenes: Math.max(1, Number(value.maxScenes) || 20),
        maxSceneSeconds: 120,
        maxTotalSeconds: 600,
        retentionDays: Math.max(1, Number(value.retentionDays) || 30),
        maxQueued: 4,
        jobTimeoutMs: 30 * 60_000,
      };
    },
  });

  // Наблюдение за исполнителями записи; заводится после старта и снимается вместе
  // с сервером.
  let showcaseWatch: NodeJS.Timeout | null = null;

  const telegramInboxChannel = createTelegramInboxChannel({
    isProjectDeleted: isDeletedProject,
    enabled: () => fastify.pluginEnabled('telegram'),
    state: async () => {
      const provider = await telegramConnection.status();
      return {
        connection: provider.connection,
        participation: undefined,
        reason: provider.reason,
      };
    },
    acquireInboxLease: asPort(() => telegramConnection.acquireLease()),
    log: fastify.log,
  });
  const githubConnection = new GitHubConnection({
    credentials: asPort(githubCredentials),
    bindings: asPort(githubBindings),
    accountContextFor: githubAccountContextFor,
    webhookBaseUrl: config.githubWebhookBaseUrl,
    enabled: () => fastify.pluginEnabled?.('github') === true,
    onChanged: notifyInboxChanged,
    log: fastify.log,
  });
  const githubInboxChannel = createGitHubInboxChannel({
    isProjectDeleted: isDeletedProject,
    enabled: () => fastify.pluginEnabled('github'),
    state: () => githubConnection.status(),
    acquireInboxLease: () => githubConnection.acquireInboxLease(),
  });
  const inboxCoordinator = new InboxCoordinator({
    channels: [telegramInboxChannel, githubInboxChannel],
  });
  const inboxTaskService = new InboxTaskService({
    coordinator: asPort(inboxCoordinator),
    tracker: asPort(tracker),
    isEnabled: () => fastify.pluginEnabled('inbox'),
    listProjects: () => listProjects(config, prefs),
    taskUrlFor: (taskId) => tracker.sourceUrl(taskId),
    attachmentAnalyzer: inboxAttachmentAnalyzer,
    // Читается живьём перед каждой загрузкой: галка в настройках действует
    // на следующую же задачу, без рестарта.
    attachmentPolicy: () => ({
      photos: readPluginSettings(fastify, 'inbox').attachPhotos !== false,
      videos: readPluginSettings(fastify, 'inbox').attachVideos === true,
    }),
    attachmentTriage: ({ item, attachmentAnalysis, operatorNote }) => runInboxTriage({
      item: asPort(item),
      attachmentAnalysis: asPort(attachmentAnalysis),
      operatorNote: asPort(operatorNote),
      // Ручной путь: человек уже решил, что задача нужна, — модель формулирует
      // постановку, а не голосует заново.
      decided: true,
      modelRef: readPluginSettings(fastify, 'inbox').triageModel ?? null,
      config,
      providerSettings: (prefs.read().providerSettings || {}) as Record<string, unknown>,
      log: fastify.log,
    }),
    onChanged: notifyInboxChanged,
    log: fastify.log,
  });
  const inboxAutoTasks = new InboxAutoTasks({
    coordinator: asPort(inboxCoordinator),
    taskService: inboxTaskService,
    tracker: asPort(tracker),
    attachmentAnalyzer: inboxAttachmentAnalyzer,
    modelRef: () => readPluginSettings(fastify, 'inbox').triageModel ?? null,
    isEnabled: () => fastify.pluginEnabled('inbox'),
    config,
    providerSettings: () => (prefs.read().providerSettings || {}) as Record<string, unknown>,
    onChanged: notifyInboxChanged,
    log: fastify.log,
  });
  const system = new SystemAdapter({ dataHome: config.dataHome });

  fastify.addHook('onClose', async () => {
    system.stop();
  });

  const taskFavoritesStore = new TaskFavoritesStore({ filePath: config.taskFavoritesPath });
  const ownPersonalTasks = new GrigdeskTaskStore({ config });
  const taskFavorites = new TaskFavoritesService({
    store: taskFavoritesStore,
    tracker,
    ownTasks: ownPersonalTasks
  });
  const taskShelfStore = new TaskShelfStore({ filePath: config.taskShelfPath });
  const taskShelf = new TaskShelfService({
    store: taskShelfStore,
    tracker,
    ownTasks: ownPersonalTasks
  });
  const taskSeenStore = new TaskSeenStore({ filePath: config.taskSeenPath });
  const taskSeen = new TaskSeenService({
    store: taskSeenStore,
    tracker,
    ownTasks: ownPersonalTasks
  });
  const analyzer = new Analyzer({
    config,
    claudeAuth,
    tracker,
    factoryState,
    prefs,
    log: fastify.log,
    // Декоратор появится ниже, вместе с модулем telegram, — поэтому ищем его в
    // момент вызова. Триаж случается много позже `ready()`, так что к тому
    // времени он уже на месте; нет модуля — оценка просто идёт без переписки.
    discussion: (
      text: unknown,
      opts?: Record<string, unknown>,
    ) => fastify.telegramDiscussion?.(text, opts),
    pluginEnabled: (id: string) => fastify.pluginEnabled?.(id) === true,
    pluginSettings: (id: string) => readPluginSettings(fastify, id),
    providerRegistry: asPort(() => fastify.providerRegistry?.() || {}),
    executorFor: asPort((id: string) => fastify.executorFor?.(id) || null),
  });
  const authStore = new AuthStore({
    legacyAccountPath: config.authAccountPath,
    sessionsPath: config.authSessionsPath,
  });
  // Просмотрщик ничего не знает о структуре GrigDesk: приложение подключает первый
  // источник явно. Следующие корни/источники добавляются здесь provider-функциями.
  const documentReader = new DocumentReader({
    rootProviders: [() => [{ id: 'grigdesk', label: 'GrigDesk', path: config.rootDir }]],
  });

  // Секрет ЭТОГО процесса для внутренних запросов: permission-prompt-tool чата работает
  // в дочернем процессе claude (cookie у него нет), но обязан достучаться до сервера.
  // Живёт только в памяти, на диск и в конфиг не попадает, меняется с каждым запуском.
  const internalToken = randomUUID();

  // Токен ЛОКАЛЬНЫХ CLI-потребителей (bin/tracker, ship-этап фабрики, скиллы): у них нет ни
  // cookie, ни памяти нашего процесса. Файл 0600 на диске машины-мозга — владение файлом
  // эквивалентно владению остальными кредами .state. Стабилен между рестартами:
  // демоны фабрики живут дольше процесса GrigDesk.
  let cliToken = '';
  try { cliToken = readFileSync(config.cliTokenPath, 'utf8').trim(); } catch { /* ещё не создан */ }
  if (!cliToken) {
    cliToken = randomUUID().replace(/-/g, '');
    mkdirSync(path.dirname(config.cliTokenPath), { recursive: true });
    writeFileSync(config.cliTokenPath, cliToken + '\n', { mode: 0o600 });
  }

  // До успешного bind ключа нет ни в памяти, ни в новой публикации файла.
  // Тот же state видит auth-модуль после асинхронного завершения onListen.
  const windowAuth: WindowAuthState = {
    origin: new URL(`http://127.0.0.1:${config.port}`).origin,
    key: null,
  };

  registerWindowKeyLifecycle(fastify, windowAuth, windowKeyPath({
    env: process.env,
    uid: process.getuid?.(),
    port: config.port,
  }));

  // Плагины платформы.
  // Гард закрывает весь /api, включая upgrade вебсокета.
  await fastify.register(authPlugin, {
    authStore,
    internalToken,
    cliToken,
    sessionOnlyPrefixes: SESSION_ONLY_PREFIXES,
  });
  // Единственный движок пишет одну runtime-проекцию; legacy-реестры в этом каталоге
  // доступны только для чтения и не требуют второго watcher-а.
  await fastify.register(ssePlugin, { stateDir: config.stateDir });
  await fastify.register(webLogModule, {
    dir: config.webLogDir,
    policy: diagnosticLogging,
    apiRoutes,
  });

  // Модули.
  await fastify.register(authModule, {
    authStore,
    windowAuth,
  });
  await fastify.register(healthModule, { config, factoryState });
  await fastify.register(helpModule, { help });
  await fastify.register<FactoryModuleOptions>(factoryModule, {
    factoryState,
    config,
    prefs,
    tracker: asPort(tracker),
    analyzer: asPort(analyzer),
    internalToken,
    arbiterCards,
    arbiterLive,
    arbiterConversations,
  });
  await fastify.register(trackerModule, { tracker });
  await fastify.register(taskFavoritesModule, { favorites: taskFavorites });
  await fastify.register(taskSeenModule, { seen: taskSeen });
  await fastify.register(systemModule, {
    system,
    config,
    desktop: desktopParent,
  });
  // Каталог сам выбирает публичный сайт по приоритету и не задерживает boot сетью.
  // Его собственные запросы завершаются при закрытии приложения.
  const pluginCatalog = new PluginCatalogService({
    applicationVersion: installOptions.grigDeskVersion,
  });

  fastify.addHook('onClose', async () => {
    await pluginCatalog.close();
  });
  await fastify.register(pluginCatalogModule, { catalog: pluginCatalog });

  // Сервис получает полный список встроенных id и только проверенные boot paths.
  // Recovery выполняется модулем до scan/import пользовательского runtime.
  const pluginInstalls = new PluginInstallService({
    ...installOptions,
    reservedIds: SYSTEM.map((manifest) => manifest.id),
    log: fastify.log,
  });

  fastify.addHook('onClose', async () => {
    await pluginInstalls.close();
  });

  // Реестр плагинов — ДО модулей-плагинов: они гейтят роуты через fastify.pluginEnabled().
  await fastify.register(pluginsModule, {
    grigDeskVersion: installOptions.grigDeskVersion,
    runtimeServices: createPluginRuntimeServices({
      config,
      project: (id) => projectsService.read(id),
      listProjects: () => projectsService.list(),
      environment: () => createPluginEnvironment(config),
      sandboxes: () => sandboxService.overview(),
      holdSandbox: (task) => sandboxActivityGuard.acquireAction(task),
      log: fastify.log,
    }),
    config,
    prefs,
    installs: pluginInstalls,
    documentReader,
    onToggle: async (id, enabled) => {
      if (id === 'ssh' && !enabled) {
        await sshService.disable();
      }
      if (id === 'db' && !enabled) {
        await dbService.disable();
      }
      if (id === 'docker' && !enabled) {
        await dockerService.disable();
      }
      if (id === 'analysis') {
        analyzer.pluginToggled(enabled);
      }
      if (id === 'showcase') {
        // Выключение не оставляет работающий конвейер: приём новых шагов
        // прекращается, а идущие задания снимаются. Данные роликов остаются.
        if (enabled) showcaseService.enable();
        else await showcaseService.disable();
      }
    },
  });
  await fastify.register(taskShelfModule, { shelf: taskShelf });
  // `speechRuntime` сюда не передаётся: раздел «Медиа» его не читает — распознавание идёт
  // через сам адаптер. Типизация показала, что аргумент был мёртвым.
  await fastify.register<MediaModuleOptions>(mediaModule, {
    media,
    speechSettings: () => prefs.read().speech,
    config,
    // Модель разбора встречи — своя настройка плагина «Видео», читается перед самым
    // запуском: смена модели в настройках действует со следующего разбора, без рестарта.
    meetingModelRef: () => readPluginSettings(fastify, 'video').triageModel ?? null,
    providerSettings: () => (prefs.read().providerSettings || {}) as Record<string, unknown>,
  });
  await fastify.register(codeModule, { config, prefs });
  await fastify.register<GitHubModuleOptions>(githubModule, {
    isProjectDeleted: isDeletedProject,
    withReferences: projectsService.withReferences,
    connection: asPort(githubConnection),
    listProjects: () => listProjects(config, prefs),
  });
  await fastify.register(inboxModule, {
    coordinator: inboxCoordinator,
    taskService: inboxTaskService,
    worker: inboxAutoTasks,
  });
  await fastify.register<TelegramModuleOptions>(telegramModule, {
    isProjectDeleted: isDeletedProject,
    withReferences: projectsService.withReferences,
    connection: asPort(telegramConnection),
    poller: telegramPoller,
    botApi: telegramBotApi,
    listProjects: () => listProjects(config, prefs),
    // Новое правило заводят только на активный проект; уже заведённые архив не трогает.
    listActiveProjects: () => listProjects(config, prefs, { includeArchived: false }),
  });
  await fastify.register(documentsModule, { reader: documentReader });
  // Сервис проектов создаётся здесь, а не внутри модуля: провайдеры связей знают
  // соседние разделы, и регистрировать их может только сборка приложения.


  // Связи проекта: каждый раздел сам отвечает, сколько записей держится за id.
  // Правила Telegram и GitHub сюда добавятся из своих модулей: их хранилища живут
  // в контекстах аккаунтов, и читать их напрямую сборке нечем.
  projectsService.registerDependencyProvider({
    kind: 'routes',
    label: 'Опубликованный каталог маршрутов',
    blocksDelete: false,
    blocksArchive: false,
    count: async (id) => {
      const store = new RoutesStore({ baseDir: config.routesDir });
      const current = await store.readCurrent(id).catch(() => null);

      return current
        ? { count: 1, items: Object.keys(current.catalog.routes).slice(0, 5) }
        : { count: 0 };
    },
  });
  projectsService.registerDependencyProvider({
    kind: 'factory',
    label: 'Попытки фабрики',
    blocksDelete: false,
    blocksArchive: false,
    count: async (id) => {
      const tasks = await factoryState.listTaskIds().catch(() => []);
      const items: string[] = [];

      for (const task of tasks) {
        const attempt = await factoryState.readTrustedAttempt(task).catch(() => null);

        if (attempt?.profile === id) {
          items.push(`попытка ${task}`);
        }
      }

      return { count: items.length, items: items.slice(0, 5) };
    },
  });
  projectsService.registerDependencyProvider({
    kind: 'ssh',
    label: 'Профили SSH',
    blocksDelete: true,
    blocksArchive: false,
    count: (id) => {
      const items = sshConnections.list()
        .filter((connection) => connection.projectId === id)
        .map((connection) => connection.label || connection.id);

      return { count: items.length, items };
    },
  });
  projectsService.registerDependencyProvider({
    kind: 'db',
    label: 'Профили баз',
    blocksDelete: true,
    blocksArchive: false,
    count: (id) => {
      const items = dbProfiles.list()
        .filter((profile) => profile.projectId === id)
        .map((profile) => profile.label || profile.id);

      return { count: items.length, items };
    },
  });
  projectsService.registerDependencyProvider({
    kind: 'showcase',
    label: 'Цели презентаций',
    blocksDelete: false,
    blocksArchive: false,
    count: async (id) => {
      const overview = await showcaseService.overview();
      const items = overview.projects
        .filter((project) => project.ref.kind === 'project' && project.ref.id === id)
        .map((project) => project.title || project.id);

      return { count: items.length, items };
    },
  });
  // Правила переживают архив и остались бы ссылками в никуда, поэтому только они
  // архив запрещают. Их адреса (чат, репозиторий) в сводку не попадают — там число.
  projectsService.registerDependencyProvider({
    kind: 'telegram',
    label: 'Правила Telegram',
    blocksDelete: true,
    blocksArchive: true,
    count: (id) => countTelegramRules(telegramConnection, id),
  });
  projectsService.registerDependencyProvider({
    kind: 'github',
    label: 'Правила GitHub',
    blocksDelete: true,
    blocksArchive: true,
    count: (id) => countGitHubRules(githubConnection, id),
  });

  await fastify.register(projectsModule, { config, prefs, service: projectsService });
  await fastify.register(grigdeskTasksModule, {
    service: trackerRuntime.own,
    config,
    tracker,
    factoryState,
    projectsService,
  });
  await fastify.register<SshModuleOptions>(sshModule, { service: asPort(sshService) });
  await fastify.register(dbModule, { service: dbService, installs: dbEngineInstalls });
  await fastify.register(dockerModule, { service: dockerService });
  await fastify.register(sandboxesModule, { service: sandboxService });
  await fastify.register(showcaseModule, { service: showcaseService });
  await fastify.register(browserModule, browser);
  await fastify.register(chatModule, {
    help,
    browser,
    projectsService,
    factoryState,
    config,
    claudeAuth,
    internalToken,
    prefs,
    speechRuntime,
    taskExists: companionTaskExists,
    permissionQueue,
    sshBroker,
    dbBroker,
    documentReader,
  });
  // `config` и `claudeAuth` сюда не передаются: раздел «Настройки» их не читает —
  // авторизацию Claude показывает раздел исполнителей, а пути берутся из сервисов.
  // Оба аргумента были мёртвыми, типизация это показала.
  await fastify.register<SettingsModuleOptions>(settingsModule, {
    prefs,
    factoryDebug,
    diagnosticLogging,
    speechRuntime,
    speechInstallation: new SpeechInstallationService({
      dataHome: config.dataHome,
      rootDir: config.rootDir,
      pythonPath: config.mediaPython,
      mediaHfDir: config.mediaHfDir,
      prepareMaintenance: () => speechRuntime.prepareMaintenance(),
      refresh: () => speechRuntime.invalidateCapabilities(),
    }),
  });
  await fastify.register(terminalModule);
  await fastify.register(routesModule, { config, prefs });
  await fastify.register(providersModule, { config, claudeAuth, prefs });
  // Прогноз лимитов слушает тик providers по SSE, поэтому регистрируется следом за ним.
  await fastify.register(usageForecastModule, { filePath: config.usageForecastPath });
  const analysisArbiter = new AnalysisArbiter({
    analyzer: asPort(analyzer),
    pluginEnabled: (id: string) => fastify.pluginEnabled(id),
    pluginSettings: (id: string) => readPluginSettings(fastify, id),
    providerRegistry: asPort(() => fastify.providerRegistry?.()),
    executorFor: asPort((id: string) => fastify.executorFor?.(id)),
    log: fastify.log,
  });
  analyzer.onAnalyzed = (id: string) => analysisArbiter.arbitrate(id, { automatic: true });
  await analyzer.start();
  await fastify.register(analysisModule, {
    analyzer,
    tracker,
    arbiter: analysisArbiter,
  });

  // Закрытые снимки и самостоятельное сообщение о запуске приложения — последними.
  await fastify.register(staticPlugin, {
    stateDir: config.stateDir,
  });

  // ── Телеграм-пульт: вотчер «требует человека» + команды/кнопки владельца ──
  // Пульт — ещё одно «окно» GrigDesk: действия идут через inject в те же ручки,
  // что жмёт браузер (X-GrigDesk-Internal — как у permission-mcp чата).
  const internalCallApi = async (method: string, url: string, payload?: unknown) => {
    const res = await fastify.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { 'x-grigdesk-internal': internalToken },
    } as InjectOptions);
    let body = null;
    try { body = res.json(); } catch { /* не-JSON ответа у этих ручек не бывает */ }
    return { statusCode: res.statusCode, body };
  };
  const internalCallRaw = async (method: string, url: string) => {
    const res = await fastify.inject({
      method,
      url,
      headers: { 'x-grigdesk-internal': internalToken },
    } as InjectOptions);

    return {
      statusCode: res.statusCode,
      headers: res.headers,
      payload: res.rawPayload,
    };
  };
  const pultCallApi = internalCallApi;
  const mobile = new MobileService({
    directory: config.mobileDir,
    port: config.mobilePort,
    relayDeployment: { transport: sshTransport, hostKeys: sshHostKeys },
    vpnGate: relayVpnGate,
    registerRoutes: (app) => registerMobileFacade(app, {
      callApi: internalCallApi,
      callRaw: internalCallRaw,
      chat: fastify.mobileChat!,
      tokens: new ActionTokens(),
      apkDirectory: config.mobileApkDir,
      subscribe: (listener) => fastify.sse?.subscribe?.(listener) ?? (() => {}),
    }),
    recoverOperation: (device, proof) => recoverChatOperation(fastify.mobileChat!, device, proof),
    changed: () => fastify.sse?.broadcast?.('mobile-changed', { at: Date.now() }),
    disconnectClient: (fp) => clientListener?.disconnect(fp),
    log: (event) => fastify.log.warn({ event }, 'мобильный доступ: изменение состояния'),
  });

  await fastify.register(mobileModule, { service: mobile });
  fastify.addHook('onListen', () => mobile.start());
  shutdown.register('mobile', () => mobile.close());
  fastify.addHook('onClose', () => mobile.close());

  let clientIdentity: Awaited<ReturnType<typeof ensureBrainIdentity>> | null = null;
  const clientBootstrapOptions = {
    pairing: mobile.pairing,
    identity: () => clientIdentity,
    name: config.serverName,
  };
  const clientBootstrap = await createClientBootstrap(clientBootstrapOptions);
  let clientListener: ClientListener | null = null;

  registerClientPairRoute(fastify, clientBootstrapOptions);
  await fastify.register(devicesModule, {
    devices: mobile.devices,
    pairing: mobile.pairing,
    listener: () => clientListener,
    identity: async () => clientIdentity ??= await ensureBrainIdentity(config.mobileDir),
    address: config.clientAccess.address,
    name: config.serverName,
    disconnectMobile: (fp) => mobile.disconnectDevice(fp),
    access: Object.assign({ root: fastify }, { mobile, config }),
  });
  fastify.addHook('onListen', async () => {
    let error = config.clientAccess.reason;

    if (config.clientAccess.state === 'configured') {
      try {
        clientIdentity = await ensureBrainIdentity(config.mobileDir);
      } catch {
        error = 'Клиентский вход не запущен: личность сервера недоступна.';
        fastify.log.warn({ event: 'client_identity_failed' }, error);
      }
    }

    clientListener = await startClientListener({
      addresses: config.clientAccess.addresses,
      identity: clientIdentity,
      devices: mobile.devices,
      app: fastify,
      bootstrap: clientBootstrap,
      error,
      log: fastify.log,
    });
  });

  /**
   * Переданные основному HTTP-серверу TLS-сокеты остаются собственностью входа.
   * Закрываем их и bootstrap при сливе, а также при прямом fastify.close в тестах.
   */
  const closeClientListener = async () => {
    await clientListener?.close();
    await clientBootstrap.close();
  };

  shutdown.register('client', closeClientListener);
  fastify.addHook('onClose', closeClientListener);

  const pultStores = new Map<string, TelegramPultStateStore>();
  // Одна фабрика state на вотчер и действия: карточки, экран навигации и реестр
  // служебных ответов живут в одном pult-state.json (merge-запись по полям).
  const pultStateStoreFor = (lease: { context: { paths: { accountDir: string } } }) => {
    const file = path.join(lease.context.paths.accountDir, 'pult-state.json');
    if (!pultStores.has(file)) {
      pultStores.set(file, new TelegramPultStateStore({ file, log: fastify.log }));
    }
    return pultStores.get(file) as TelegramPultStateStore;
  };
  const pultWatch = new TelegramPultWatch({
    acquireLease: asPort(() => telegramConnection.acquireLease()),
    isEnabled: () => fastify.pluginEnabled?.('telegram') === true,
    callApi: pultCallApi,
    stateStoreFor: asPort(pultStateStoreFor),
    queue: pultQueue,
    subscribe: asPort((listener: (name: string, payload?: unknown) => void) => (
      fastify.sse?.subscribe?.(listener) ?? (() => {})
    )),
    log: fastify.log,
  });
  telegramPult = {
    watch: pultWatch,
    actions: new TelegramPultActions({
      isEnabled: () => fastify.pluginEnabled?.('telegram') === true,
      callApi: pultCallApi,
      summary: () => pultWatch.statusSnapshot(),
      forget: (key: string) => pultWatch.forget(key),
      stateStoreFor: asPort(pultStateStoreFor),
      acquireLease: asPort(() => telegramConnection.acquireLease()),
      subscribe: asPort((listener: (name: string, payload?: unknown) => void) => (
        fastify.sse?.subscribe?.(listener) ?? (() => {})
      )),
      speechRuntime,
      readSpeechPrefs: () => prefs.read().speech as Record<string, unknown> | undefined,
      readCompactWindow: () => prefs.read().chatAutoCompactWindow,
      readPollStatus: () => telegramPoller.status(),
      queue: pultQueue,
      log: fastify.log,
    }),
  };

  // Опрос Телеграма поднимаем только при подключённом боте: без токена цикл всё
  // равно ничего не делает, а с ним — начинает собирать сообщения сразу после
  // старта, не дожидаясь, пока кто-то откроет раздел. Дальше его заводит и гасит
  // сам модуль (connect/disconnect).
  // Там же заводим автомат «жалоба → задача»: сам модуль его только собирает.
  // Крутиться вхолостую ему нечем — выключенный плагин и невыбранная модель
  // отсеиваются в первых строках захода.
  // Автоматический разбор типизированных остановок конвейера. Заводится безусловно и
  // гейтится живьём (prefs `arbiter.auto`, по умолчанию выключено), как вотчер пульта:
  // включение не должно требовать рестарта. Своего опроса состояния у него нет — он
  // просыпается по той же шине `state-change`, что и окна.
  const arbiterWatch = new FactoryArbiterWatch({
    // Ленивая ссылка, как у вотчера пульта рядом: порядок регистрации плагинов не должен
    // становиться скрытым условием работы вотчера.
    sse: {
      subscribe: (listener) => fastify.sse?.subscribe?.(listener) ?? (() => {}),
    },
    prefs,
    listTasks: async () => {
      // Гард закрывает ВЕСЬ /api, включая GET, поэтому inject без заголовка получает
      // 401, а вотчер молча читает пустой список: ни одной задачи, ни одной строки в
      // журнале. Внутренний токен — тот же приём, что у пульта и permission-mcp чата.
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/tasks',
        headers: { 'x-grigdesk-internal': internalToken },
      });
      if (response.statusCode !== 200) {
        fastify.log.warn({ status: response.statusCode }, 'арбитр: список задач не прочитан');
        return [];
      }
      return response.json().tasks || [];
    },
    // Дешёвый фильтр перед дорогим обходом: реестр — плоский KEY=VALUE, остановку в нём
    // видно без журналов попыток, вердиктов и графов. Пока остановленных задач нет,
    // короткая пауза вотчера ничего не стоит.
    hasStopped: async () => {
      const ids = await factoryState.listTaskIds().catch(() => []);
      for (const id of ids) {
        const { registry } = await factoryState.readRegistry(id).catch(() => ({ registry: null }));
        if (registry?.STALLED_HUMAN === '1' && !registry.ORCH_PID) return true;
      }
      return false;
    },
    arbitrate: asPort(
      (task: string, reply: Parameters<NonNullable<typeof fastify.factoryArbitrate>>[1]) =>
        fastify.factoryArbitrate?.(task, reply, { actor: 'auto' }),
    ),
    log: fastify.log,
  });

  fastify.addHook('onReady', async () => {
    await githubConnection.initialize();
    const telegramState = await telegramConnection.initialize();
    githubConnection.start();
    if (telegramState.connection === 'connected') telegramPoller.start();
    inboxAutoTasks.start();
    // Вотчер пульта сам гейтится живьём (плагин, подключение, подтверждённый
    // владелец), поэтому заводится безусловно: включение пульта не требует рестарта.
    pultWatch.start();
    // Сверка незавершённых ходов ходит во внутренние HTTP-ручки через fastify.inject.
    // Ждать её внутри onReady нельзя: inject сам ждёт готовности Fastify, и получается
    // замкнутое ожидание до FST_ERR_HOOK_TIMEOUT. После выхода из хука сверка доедет в фоне.
    void telegramPult?.actions?.start().catch((error: unknown) => {
      fastify.log.warn({ err: error }, 'telegram-pult: восстановление после старта сорвалось');
    });
    arbiterWatch.start();
    // Подъём песочницы переживает перезапуск сервера, поэтому журнал заданий сверяется
    // с реальностью на старте: живой процесс снова под наблюдением, исчезнувший
    // перестаёт вечно «идти».
    void sandboxService.resume().catch((error) => {
      fastify.log.warn({ err: error }, 'песочницы: сверка журнала после старта не удалась');
    });
    // Запись браузера идёт отдельным процессом и переживает перезапуск, поэтому
    // журнал заданий раздела сверяется с процессами. До сверки очередь новых
    // заданий не выдаёт: второй worker на ту же цель испортил бы запись первому.
    void showcaseService.recover().catch((error) => {
      fastify.log.warn({ err: error }, 'презентации: сверка журнала заданий не удалась');
    });
    // Отсоединённый исполнитель пишет свой журнал файлом, поэтому сервер его
    // перечитывает: подписки на чужой процесс нет, а зависший обязан стать видимой
    // причиной, а не бесконечным «идёт».
    showcaseWatch = setInterval(() => {
      void showcaseService.pollWorkers().catch((error) => {
        fastify.log.warn({ err: error }, 'презентации: наблюдение за исполнителем сорвалось');
      });
    }, 2000);
    showcaseWatch.unref?.();
  });
  fastify.addHook('onClose', async () => {
    if (showcaseWatch) {
      clearInterval(showcaseWatch);
      showcaseWatch = null;
    }

    await showcaseService.disable();
    sandboxService.stop();
    githubConnection.stop();
    telegramPult?.actions?.stop();
    await telegramPoller.stop();
    await pultWatch.stop();
    inboxAutoTasks.stop();
    arbiterWatch.stop();
    await speechRuntime.shutdown();
  });

  return fastify;
}

/**
 * Проверяет рантайм, собирает сервисы и включает сервер.
 * Ошибка listen закрывает частично поднятый Fastify и возвращается вызывающему;
 * ошибка папки данных приходит раньше, из startDataHome, и сюда не попадает.
 */
export async function startServer(): Promise<FastifyInstance> {
  // Версию проверяем до сборки сервисов: дальше отказ выглядел бы поломкой
  // конкретного модуля, а не устаревшим рантаймом.
  assertSupportedNode();

  const desktopParent = attachDesktopParent({
    env: process.env,
    channel: typeof process.send === 'function' ? process : null,
    exit: (code) => process.exit(code),
  });
  const app = await build(desktopParent);

  if (process.env.GRIGDESK_HOST !== undefined) {
    app.log.warn('GRIGDESK_HOST больше не поддерживается: GrigDesk слушает только 127.0.0.1');
  }

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error);
    await app.close().catch(() => {});

    throw error;
  }

  app.log.info(`GrigDesk слушает http://127.0.0.1:${config.port}`);
  app.shutdown?.arm();

  if (desktopParent && app.shutdown) {
    const shutdown = app.shutdown;

    desktopParent.bindShutdown((reason) => shutdown.begin(reason));
  }

  return app;
}

// app.ts запускается и как исполняемый вход, и через app.js/SEA-вход: guard по argv[1]
// здесь запрещён. Ошибка старта не оставляет процесс с успешным кодом.
void startServer().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);

  process.stderr.write(`GrigDesk не запустился: ${detail}\n`);
  // Живые таймеры, watchers или дочерние процессы могли стартовать до отказа:
  // exitCode их не остановит, и сервер повис бы без признака падения для окна/systemd.
  process.exit(1);
});
