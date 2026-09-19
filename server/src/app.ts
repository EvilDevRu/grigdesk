// Ядро сервера кокпита. Явная сборка: конфиг → адаптеры → плагины → модули → listen.
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

import { assertSupportedNode } from './lib/nodeVersion.ts';
import { createShutdownCoordinator } from './lib/shutdown.ts';
import { config } from './config.ts';
import { cockpitCliPath } from './lib/cliPath.ts';
import { AuthStore } from './lib/authStore.ts';
import { FactoryStateAdapter } from './adapters/factoryState.ts';
import { ArbiterCardsStore } from './lib/arbiterCards.ts';
import { B24Adapter } from './adapters/b24.ts';
import { SystemAdapter } from './adapters/system.ts';
import { MediaAdapter } from './adapters/media.ts';
import { extractSceneFrames } from './lib/media/ingest.ts';
import { CredsStore } from './lib/b24/credsStore.ts';
import { ClaudeAuthStore } from './lib/claudeAuthStore.ts';
import { PrefsStore } from './lib/prefsStore.ts';
import { SpeechRuntime } from './lib/speech/index.ts';
import { ModelJobManager } from './lib/speech/modelJobs.ts';
import { listProjects } from './lib/profiles.ts';
import { projectMapsRoot } from './lib/projects.ts';
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
import { cancelDbQuery, createDbBroker } from './lib/db/broker.ts';
import type { LimitedDbResult } from './lib/db/result.ts';
import type { FactoryModuleOptions } from './modules/factory/index.ts';
import type { KnowledgeModuleOptions } from './modules/knowledge/index.ts';
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
import { createKnowledgeClient } from './lib/search/client.ts';
import { createKnowledgeBroker } from './lib/search/broker.ts';
import { createKnowledgeTransfer } from './lib/search/transfer.ts';

import authPlugin from './plugins/auth.ts';
import httpScopePlugin from './plugins/httpScope.ts';
import ssePlugin from './plugins/sse.ts';
import staticPlugin from './plugins/static.ts';
import { LocalTls } from './lib/tls/local.ts';
import { loadTlsSource } from './lib/tls/source.ts';
import { startHttpsListener } from './lib/tls/httpsListener.ts';

import healthModule from './modules/health/index.ts';
import factoryModule from './modules/factory/index.ts';
import b24Module from './modules/b24/index.ts';
import taskFavoritesModule from './modules/task-favorites/index.ts';
import taskShelfModule from './modules/task-shelf/index.ts';
import taskSeenModule from './modules/task-seen/index.ts';
import systemModule from './modules/system/index.ts';
import mediaModule from './modules/media/index.ts';
import chatModule from './modules/chat/index.ts';
import settingsModule from './modules/settings/index.ts';
import terminalModule from './modules/terminal/index.ts';
import agentsModule from './modules/agents/index.ts';
import routesModule from './modules/routes/index.ts';
import providersModule from './modules/providers/index.ts';
import usageForecastModule from './modules/usage-forecast/index.ts';
import analysisModule from './modules/analysis/index.ts';
import authModule from './modules/auth/index.ts';
import gatewayModule from './modules/gateway/index.ts';
import pluginsModule from './modules/plugins/index.ts';
import projectsModule from './modules/projects/index.ts';
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
import knowledgeModule from './modules/knowledge/index.ts';
import { Analyzer } from './lib/analysis/analyzer.ts';
import { AnalysisArbiter } from './lib/analysis/arbiter.ts';
import { DocumentReader } from './lib/documents/reader.ts';

// npm start и существующий systemd-юнит тоже дают агентам CLI текущей установки.
// Дочерние процессы наследуют этот PATH независимо от рабочего каталога задачи.
process.env.PATH = cockpitCliPath(config.rootDir);

// Настройки нужны ещё до сборки приложения: тумблер режима доступа решает, поднимать ли
// https-сокет, а сокет создаётся один раз при старте.
const prefs = new PrefsStore({ prefsPath: config.prefsPath });

// Локальный HTTPS: выпуск сертификата из «Настроек» и состояние https-сокета в рантайме.
// `tlsRuntime` — общий мутируемый объект: его читают и плагин области http-сокета, и
// `/api/settings/tls` (чтобы отличать «файлы на диске» от «процесс действительно слушает»).
const localTls = new LocalTls({ dir: config.tlsDir, caDir: config.tlsCaDir });
const tlsLoaded = loadTlsSource({
  keyPath: config.tlsKeyPath,
  certPath: config.tlsCertPath,
  modeEnabled: prefs.read().accessLocalHttps === true,
  localTls,
});
// Состояние второго сокета. Живёт вне `build()`, потому что https поднимается уже
// ПОСЛЕ `listen()`, а раздел «Доступ» показывает его в любой момент.
const tlsRuntime: {
  source: string;
  port: number;
  httpPort: number;
  up: boolean;
  error: string;
  fingerprint: string;
  server: import('node:https').Server | null;
} = {
  source: tlsLoaded.source,
  port: config.tlsPort,
  httpPort: config.port,
  up: false,
  error: tlsLoaded.error || '',
  fingerprint: '',
  server: null,
};

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

async function build() {
  const fastify = Fastify({
    logger: { level: config.isDev ? 'debug' : 'info' },
    // trustProxy — только по явной настройке и только для адреса шлюза (см. config.trustProxy).
    // Без неё заголовки `X-Forwarded-*` игнорируются: иначе клиент сам назначал бы себе адрес.
    ...(config.trustProxy ? { trustProxy: config.trustProxy } : {}),
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
  const knowledge = createKnowledgeClient({
    dbPath: config.knowledgeDbPath,
    seedSamples: false,
  });
  const knowledgeTransfer = createKnowledgeTransfer({
    rootDir: config.rootDir,
    dbPath: config.knowledgeDbPath,
    knowledge,
    mapsRootFor: (project) => projectMapsRoot({ config, prefs, id: project }),
    listKnownProjects: () => listProjects(config, prefs),
  });
  const knowledgeBroker = createKnowledgeBroker({
    pluginEnabled: (id: string) => fastify.pluginEnabled?.(id) === true,
    // Клиент знаний отвечает недоверенным JSON воркера, поэтому его методы объявлены
    // через `unknown`; брокер же перечисляет, что именно он спрашивает. Приведение одно.
    knowledge: asPort(knowledge),
    transfer: knowledgeTransfer,
    log: fastify.log,
  });
  fastify.decorate('knowledgeBroker', knowledgeBroker);
  fastify.addHook('onClose', async () => knowledge.close());

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
  });
  const permissionQueue = createPermissionQueue();
  const sshConnections = await createSshStore({
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

  const dbEngines = await createEngineRegistry();
  const dbProfiles = await createDbStore({
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
  interface DbQueryRecord extends Record<string, unknown> {
    id: string;
    sessionId: string;
    actor: string;
    text: string;
    queryClass: string | null;
    tables: string[];
    state: 'running' | 'done' | 'error' | 'cancelled';
    startedAt: string;
    finishedAt: string | null;
    error?: string | null;
    result: LimitedDbResult | { ok: false; error: string } | null;
  }

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

  const dbService = {
    listEngines: () => dbEngines.list(),
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
    async query(id: string, input: { text?: unknown; params?: unknown[] }) {
      const session = dbSessions.find(id);
      if (!session) {
        throw Object.assign(new Error('DB-сессия не найдена'), { code: 'session_not_found' });
      }
      const query: DbQueryRecord = {
        id: randomUUID(),
        sessionId: session.id,
        actor: 'human',
        text: String(input.text || ''),
        queryClass: null,
        tables: [],
        state: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
      };
      dbQueries.set(query.id, query);
      const run = { id: query.id, queryId: query.id };
      const untrack = dbSessions.trackRun(session.id, run);
      fastify.sse?.broadcast?.('db-queries', { queryId: query.id });
      Promise.resolve().then(async () => {
        try {
          const execute = session.engine.execute as (
            handle: unknown,
            request: Record<string, unknown>,
          ) => Promise<unknown>;
          const raw = await execute(session.handle, {
            text: query.text,
            params: input.params || [],
            queryId: query.id,
            limits: dbSettings(),
          });
          query.result = await normalizeDbResult(raw, { ...dbSettings(), completed: true });
          query.state = 'done';
          await dbAudit.append({
            projectId: session.profile.projectId,
            sessionId: session.id,
            actor: 'human',
            query: query.text,
            outcome: 'success',
            rows: Number((query.result as LimitedDbResult | null)?.totalRows ?? 0),
            bytes: Number((query.result as LimitedDbResult | null)?.totalBytes ?? 0),
            truncated: Boolean((query.result as LimitedDbResult | null)?.truncated),
          });
        } catch {
          query.state = 'error';
          query.result = { ok: false, error: 'query_failed' };
          await dbAudit.append({
            projectId: session.profile.projectId,
            sessionId: session.id,
            actor: 'human',
            query: query.text,
            outcome: 'query_failed',
          });
        } finally {
          query.finishedAt = new Date().toISOString();
          (untrack as (() => void) | undefined)?.();
          fastify.sse?.broadcast?.('db-queries', { queryId: query.id });
        }
      });
      return { queryId: query.id };
    },
    listQueries: () => [...dbQueries.values()].map(publicDbQuery),
    getQuery: (id: string) => publicDbQuery(dbQueries.get(id)),
    async cancelQuery(id: string) {
      const query = dbQueries.get(id);
      const session = query ? dbSessions.find(query.sessionId) : null;
      const outcome = await cancelDbQuery({
        query: query as unknown as Record<string, unknown> | null,
        session: session as unknown as Record<string, unknown> | null,
        sessions: dbSessions as unknown as Record<string, unknown>,
      });
      if (!outcome.ok || !query) return outcome;
      query.state = 'cancelled';
      query.finishedAt = new Date().toISOString();
      fastify.sse?.broadcast?.('db-queries', { queryId: query.id });
      return { ok: true, method: outcome.method };
    },
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
  const credsStore = new CredsStore({ credsPath: config.b24CredsPath, baseUrl: config.b24BaseUrl });
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
  const b24 = new B24Adapter({ credsStore, cookiePath: config.b24CookiePath });
  // Идентичность companion-чата можно создать и для запущенной задачи фабрики, и для
  // существующей задачи Б24 до запуска. Подтвердить её имеют право только эти
  // серверные источники.
  const companionTaskExists = async (taskId: string | number) => {
    try {
      await factoryState.readRegistry(taskId);
      return true;
    } catch { /* задача законно может существовать только в Б24 до запуска конвейера */ }
    if (!b24.isConfigured()) return false;
    try { return Boolean(await b24.taskDetail(taskId)); }
    catch { return false; }
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
    bootstrapPython: process.env.COCKPIT_MEDIA_BOOTSTRAP_PYTHON || 'python3',
    listProjects: () => listProjects(config, prefs),
    sandboxOverview: () => sandboxService.overview(),
    sandboxActivityGuard,
    broadcast: (event: string, data?: unknown) => fastify.sse?.broadcast?.(event, data),
    // Расшифровка для самопроверки речи идёт через общий речевой runtime кокпита —
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
    taskDetails: async (taskId: string) => await b24.taskDetail(taskId) as {
      title?: unknown;
      description?: unknown;
    } | null,
    // Каналы доставки: сессией портала и аккаунтом Telegram владеет сервер, раздел
    // получает их готовыми и вторых не заводит.
    deliveryDeps: {
      b24,
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
    enabled: () => fastify.pluginEnabled('github'),
    state: () => githubConnection.status(),
    acquireInboxLease: () => githubConnection.acquireInboxLease(),
  });
  const inboxCoordinator = new InboxCoordinator({
    channels: [telegramInboxChannel, githubInboxChannel],
  });
  const inboxTaskService = new InboxTaskService({
    coordinator: asPort(inboxCoordinator),
    b24: asPort(b24),
    isEnabled: () => fastify.pluginEnabled('inbox'),
    listProjects: () => listProjects(config, prefs),
    taskUrlFor: async (taskId) => {
      const identity = await b24.accountIdentity();
      if (!identity?.baseUrl || !identity?.userId) return '';
      const base = String(identity.baseUrl).replace(/\/+$/u, '');
      return `${base}/company/personal/user/${identity.userId}/tasks/task/view/${taskId}/`;
    },
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
    b24: asPort(b24),
    attachmentAnalyzer: inboxAttachmentAnalyzer,
    modelRef: () => readPluginSettings(fastify, 'inbox').triageModel ?? null,
    isEnabled: () => fastify.pluginEnabled('inbox'),
    config,
    providerSettings: () => (prefs.read().providerSettings || {}) as Record<string, unknown>,
    onChanged: notifyInboxChanged,
    log: fastify.log,
  });
  const system = new SystemAdapter();
  const taskFavoritesStore = new TaskFavoritesStore({ filePath: config.taskFavoritesPath });
  const taskFavorites = new TaskFavoritesService({ store: taskFavoritesStore, b24 });
  const taskShelfStore = new TaskShelfStore({ filePath: config.taskShelfPath });
  const taskShelf = new TaskShelfService({ store: taskShelfStore, b24 });
  const taskSeenStore = new TaskSeenStore({ filePath: config.taskSeenPath });
  const taskSeen = new TaskSeenService({ store: taskSeenStore, b24 });
  const factoryDebug = new FactoryDebugSettings({
    factoryBin: config.factoryBin,
    stateDir: config.stateDir,
    configRoot: config.factoryConfigRoot,
    profilesDir: config.profilesDir,
  });
  const analyzer = new Analyzer({
    config, claudeAuth, b24, factoryState, prefs, log: fastify.log,
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
    accountPath: config.authAccountPath,
    sessionsPath: config.authSessionsPath,
  });
  // Просмотрщик ничего не знает о структуре Cockpit: приложение подключает первый
  // источник явно. Следующие корни/источники добавляются здесь provider-функциями.
  const documentReader = new DocumentReader({
    rootProviders: [() => [{ id: 'cockpit', label: 'Cockpit', path: config.rootDir }]],
  });

  // Секрет ЭТОГО процесса для внутренних запросов: permission-prompt-tool чата работает
  // в дочернем процессе claude (cookie у него нет), но обязан достучаться до сервера.
  // Живёт только в памяти, на диск и в конфиг не попадает, меняется с каждым запуском.
  const internalToken = randomUUID();

  // Токен ЛОКАЛЬНЫХ CLI-потребителей (bin/b24, ship-этап фабрики, скиллы): у них нет ни
  // cookie, ни памяти нашего процесса. Файл 0600 на диске машины-мозга — владение файлом
  // эквивалентно владению остальными кредами .state. Стабилен между рестартами:
  // демоны фабрики живут дольше процесса кокпита.
  let cliToken = '';
  try { cliToken = readFileSync(config.cliTokenPath, 'utf8').trim(); } catch { /* ещё не создан */ }
  if (!cliToken) {
    cliToken = randomUUID().replace(/-/g, '');
    mkdirSync(path.dirname(config.cliTokenPath), { recursive: true });
    writeFileSync(config.cliTokenPath, cliToken + '\n', { mode: 0o600 });
  }

  // Плагины платформы.
  // Область http-сокета — ПЕРЕД гардом: разлогиненное устройство из сети должно получить
  // редирект на https, а не 401, иначе оно не доберётся даже до экрана входа.
  await fastify.register(httpScopePlugin, { tlsRuntime });
  // Гард — сразу следом: он закрывает весь /api, включая upgrade вебсокета.
  await fastify.register(authPlugin, {
    authStore,
    tlsEnabled: tlsLoaded.source !== 'none',
    trustProxy: config.trustProxy,
    internalToken,
    cliToken,
  });
  // Единственный движок пишет одну runtime-проекцию; legacy-реестры в этом каталоге
  // доступны только для чтения и не требуют второго watcher-а.
  await fastify.register(ssePlugin, { stateDir: config.stateDir });

  // Модули.
  await fastify.register(authModule, { authStore, config });
  await fastify.register(gatewayModule, { config, prefs });
  await fastify.register(healthModule, { config, factoryState });
  await fastify.register<FactoryModuleOptions>(factoryModule, {
    factoryState,
    config,
    prefs,
    b24: asPort(b24),
    analyzer: asPort(analyzer),
    internalToken,
    arbiterCards,
    arbiterLive,
  });
  await fastify.register(b24Module, { b24 });
  await fastify.register(taskFavoritesModule, { favorites: taskFavorites });
  await fastify.register(taskSeenModule, { seen: taskSeen });
  await fastify.register(systemModule, { system, config });
  // Реестр плагинов — ДО модулей-плагинов: они гейтят роуты через fastify.pluginEnabled().
  await fastify.register(pluginsModule, {
    config,
    prefs,
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
  await fastify.register<KnowledgeModuleOptions>(knowledgeModule, {
    knowledge: asPort(knowledge),
    transfer: asPort(knowledgeTransfer),
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
    connection: asPort(githubConnection),
    listProjects: () => listProjects(config, prefs),
  });
  await fastify.register(inboxModule, {
    coordinator: inboxCoordinator,
    taskService: inboxTaskService,
    worker: inboxAutoTasks,
  });
  await fastify.register<TelegramModuleOptions>(telegramModule, {
    connection: asPort(telegramConnection),
    poller: telegramPoller,
    botApi: telegramBotApi,
    listProjects: () => listProjects(config, prefs),
  });
  await fastify.register(documentsModule, { reader: documentReader });
  await fastify.register(projectsModule, { config, prefs });
  await fastify.register<SshModuleOptions>(sshModule, { service: asPort(sshService) });
  await fastify.register(dbModule, { service: dbService });
  await fastify.register(dockerModule, { service: dockerService });
  await fastify.register(sandboxesModule, { service: sandboxService });
  await fastify.register(showcaseModule, { service: showcaseService });
  await fastify.register(chatModule, {
    factoryState, config, claudeAuth, internalToken, prefs, speechRuntime,
    taskExists: companionTaskExists,
    permissionQueue,
    sshBroker,
    dbBroker,
    knowledgeBroker,
  });
  // `config` и `claudeAuth` сюда не передаются: раздел «Настройки» их не читает —
  // авторизацию Claude показывает раздел исполнителей, а пути берутся из сервисов.
  // Оба аргумента были мёртвыми, типизация это показала.
  await fastify.register<SettingsModuleOptions>(settingsModule, {
    credsStore: asPort(credsStore),
    b24: asPort(b24),
    prefs,
    factoryDebug,
    localTls: asPort(localTls),
    tlsRuntime,
    speechRuntime,
  });
  await fastify.register(terminalModule);
  await fastify.register(agentsModule, { config });
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
  await fastify.register(analysisModule, { analyzer, arbiter: analysisArbiter });

  // Статика — последней (SPA-fallback перехватывает не-API 404).
  await fastify.register(staticPlugin, { webDist: config.webDist, stateDir: config.stateDir });

  // ── Телеграм-пульт: вотчер «требует человека» + команды/кнопки владельца ──
  // Пульт — ещё одно «окно» кокпита: действия идут через inject в те же ручки,
  // что жмёт браузер (X-Cockpit-Internal — как у permission-mcp чата).
  const pultCallApi = async (method: string, url: string, payload?: unknown) => {
    const res = await fastify.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { 'x-cockpit-internal': internalToken },
    } as InjectOptions);
    let body = null;
    try { body = res.json(); } catch { /* не-JSON ответа у этих ручек не бывает */ }
    return { statusCode: res.statusCode, body };
  };
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
        headers: { 'x-cockpit-internal': internalToken },
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
      (task: string, reply: unknown) => fastify.factoryArbitrate?.(task, reply, { actor: 'auto' }),
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

  // Второй сокет закрываем вместе с сервером: иначе `bin/restart` поднимет новый процесс,
  // а тот упрётся в EADDRINUSE на порту, который скрипт даже не проверяет.
  fastify.addHook('onClose', async () => {
    const server = tlsRuntime.server;

    if (!server) return;
    // Как и у http-сокета: SSE с планшета держал бы `close()` до SIGKILL.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    tlsRuntime.server = null;
    tlsRuntime.up = false;
  });

  return fastify;
}

/**
 * Поднять https и записать результат в `tlsRuntime` — от него зависит область http-сокета.
 * Вызывать ПОСЛЕ `listen()`: до готовности приложения плагин вебсокета ещё не повесил upgrade.
 */
async function startHttps(app: FastifyInstance): Promise<void> {
  if (!tlsLoaded.key) {
    if (tlsRuntime.error) {
      app.log.error(`HTTPS не поднят: ${tlsRuntime.error}. Кокпит работает по http — сертификат можно перевыпустить в «Настройки → Доступ».`);
    }
    return;
  }
  const result = await startHttpsListener({
    app,
    key: tlsLoaded.key,
    cert: tlsLoaded.cert as Buffer,
    port: config.tlsPort,
    host: config.host,
  });
  if (!result.ok) {
    // Занятый порт или отказ в биндинге — не повод убивать процесс: http живёт, UI доступен
    // с мозга, причина видна в «Настройки → Доступ».
    tlsRuntime.error = String(result.error);
    app.log.error(`HTTPS не поднят на :${config.tlsPort}: ${result.error}`);
    return;
  }
  tlsRuntime.server = result.server ?? null;
  tlsRuntime.up = true;
  tlsRuntime.fingerprint = String(tlsLoaded.fingerprint ?? '');
  app.log.info(`HTTPS слушает :${config.tlsPort} (сертификат из «${tlsLoaded.source}»); http на :${config.port} — loopback и корневой сертификат.`);
}

// Версию проверяем до сборки сервисов: дальше отказ выглядел бы поломкой
// конкретного модуля, а не устаревшим рантаймом.
assertSupportedNode();

const app = await build();
try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
await startHttps(app);
app.shutdown?.arm();
