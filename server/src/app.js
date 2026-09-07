// Ядро сервера кокпита. Явная сборка: конфиг → адаптеры → плагины → модули → listen.
// Никакой автозагрузки (YAGNI): модули регистрируются списком, зависимости передаём явно.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';

import { config } from './config.js';
import { cockpitCliPath } from './lib/cli-path.js';
import { AuthStore } from './lib/auth-store.js';
import { FactoryStateAdapter } from './adapters/factory-state.js';
import { ArbiterCardsStore } from './lib/arbiter-cards.js';
import { B24Adapter } from './adapters/b24.js';
import { SystemAdapter } from './adapters/system.js';
import { MediaAdapter } from './adapters/media.js';
import { extractSceneFrames } from './lib/media/ingest.js';
import { CredsStore } from './lib/b24/creds-store.js';
import { ClaudeAuthStore } from './lib/claude-auth-store.js';
import { PrefsStore } from './lib/prefs-store.js';
import { SpeechRuntime } from './lib/speech/index.js';
import { ModelJobManager } from './lib/speech/model-jobs.js';
import { listProjects } from './lib/profiles.js';
import { projectMapsRoot } from './lib/projects.js';
import * as telegramBotApi from './lib/telegram/api.js';
import { TelegramAccountBindings } from './lib/telegram/account-bindings.js';
import { createTelegramAccountContextFactory } from './lib/telegram/account-context.js';
import { TelegramAccountPoller } from './lib/telegram/account-poller.js';
import { TelegramConnection } from './lib/telegram/connection.js';
import { TelegramCredentialsStore } from './lib/telegram/credentials-store.js';
import { createTelegramInboxChannel } from './lib/telegram/inbox-channel.js';
import { TelegramPultActions } from './lib/telegram/pult/actions.js';
import { TelegramPultStateStore } from './lib/telegram/pult/state-store.js';
import { TelegramPultWatch } from './lib/telegram/pult/watch.js';
import { PultSendQueue } from './lib/telegram/pult/send-queue.js';
import { GitHubAccountBindings } from './lib/github/account-bindings.js';
import { createGitHubAccountContextFactory } from './lib/github/account-context.js';
import { GitHubConnection } from './lib/github/connection.js';
import { GitHubCredentialsStore } from './lib/github/credentials-store.js';
import { createGitHubInboxChannel } from './lib/github/inbox-channel.js';
import { INBOX_REF_LIMITS } from './lib/inbox/identity.js';
import { InboxCoordinator } from './lib/inbox/coordinator.js';
import { InboxAttachmentAnalyzer } from './lib/inbox/attachment-analysis.js';
import { InboxTaskService } from './lib/inbox/task-service.js';
import { InboxAutoTasks } from './lib/inbox/auto-tasks.js';
import { FactoryArbiterWatch } from './lib/factory-arbiter-watch.js';
import { FactoryArbiterLive } from './lib/factory-arbiter-live.js';
import { runInboxTriage } from './lib/inbox/triage.js';
import { FactoryDebugSettings } from './lib/factory-debug.js';
import { readRouteWorkTime } from './lib/factory-route-cli.js';
import { TaskFavoritesStore } from './lib/task-favorites-store.js';
import { TaskFavoritesService } from './lib/task-favorites-service.js';
import { TaskShelfStore } from './lib/task-shelf-store.js';
import { TaskShelfService } from './lib/task-shelf-service.js';
import { TaskSeenStore } from './lib/task-seen-store.js';
import { TaskSeenService } from './lib/task-seen-service.js';
import { createPermissionQueue } from './lib/chat/permission-queue.js';
import { createSshStore } from './lib/ssh/store.js';
import { createHostKeyStore } from './lib/ssh/host-keys.js';
import { createSshTransport } from './lib/ssh/transport.js';
import { createSshSessionManager } from './lib/ssh/session-manager.js';
import { createSshAudit } from './lib/ssh/audit.js';
import { createSshBroker } from './lib/ssh/broker.js';
import { createEngineRegistry } from './lib/db/engine-registry.js';
import { createDbStore } from './lib/db/store.js';
import { createDbSessionManager } from './lib/db/session-manager.js';
import { createDbAudit } from './lib/db/audit.js';
import { cancelDbQuery, createDbBroker } from './lib/db/broker.js';
import { normalizeDbResult } from './lib/db/result.js';
import { createDockerService } from './lib/docker/service.ts';
import { createKnowledgeClient } from './lib/search/client.js';
import { createKnowledgeBroker } from './lib/search/broker.js';
import { createKnowledgeTransfer } from './lib/search/transfer.js';

import authPlugin from './plugins/auth.js';
import httpScopePlugin from './plugins/http-scope.js';
import ssePlugin from './plugins/sse.js';
import staticPlugin from './plugins/static.js';
import { LocalTls } from './lib/tls/local.js';
import { loadTlsSource } from './lib/tls/source.js';
import { startHttpsListener } from './lib/tls/https-listener.js';

import healthModule from './modules/health/index.js';
import factoryModule from './modules/factory/index.js';
import b24Module from './modules/b24/index.js';
import taskFavoritesModule from './modules/task-favorites/index.js';
import taskShelfModule from './modules/task-shelf/index.js';
import taskSeenModule from './modules/task-seen/index.js';
import systemModule from './modules/system/index.js';
import mediaModule from './modules/media/index.js';
import chatModule from './modules/chat/index.js';
import settingsModule from './modules/settings/index.js';
import terminalModule from './modules/terminal/index.js';
import agentsModule from './modules/agents/index.js';
import routesModule from './modules/routes/index.js';
import providersModule from './modules/providers/index.js';
import analysisModule from './modules/analysis/index.js';
import authModule from './modules/auth/index.js';
import gatewayModule from './modules/gateway/index.js';
import pluginsModule from './modules/plugins/index.js';
import projectsModule from './modules/projects/index.js';
import codeModule from './modules/code/index.js';
import telegramModule from './modules/telegram/index.js';
import githubModule from './modules/github/index.js';
import inboxModule from './modules/inbox/index.js';
import documentsModule from './modules/documents/index.js';
import sshModule from './modules/ssh/index.js';
import dbModule from './modules/db/index.js';
import dockerModule from './modules/docker/index.ts';
import knowledgeModule from './modules/knowledge/index.js';
import { Analyzer } from './lib/analysis/analyzer.js';
import { AnalysisArbiter } from './lib/analysis/arbiter.js';
import { DocumentReader } from './lib/documents/reader.js';

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
const tlsRuntime = {
  source: tlsLoaded.source,
  port: config.tlsPort,
  httpPort: config.port,
  up: false,
  error: tlsLoaded.error || '',
  fingerprint: '',
  server: null,
};

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
  });
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
    pluginEnabled: (id) => fastify.pluginEnabled?.(id) === true,
    knowledge,
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
    echoEnabled: () => fastify.pluginSettings?.('ssh')?.echoToTerminal !== false,
  });
  const sshAuditStore = await createSshAudit({ dir: config.sshAuditDir });
  const sshAudit = {
    async append(entry) {
      const result = await sshAuditStore.append(entry);
      fastify.sse.broadcast('ssh-audit', { at: result.at });
      return result;
    },
  };
  const sshBroker = createSshBroker({
    pluginEnabled: (id) => fastify.pluginEnabled?.(id) === true,
    sessions: sshSessions,
    permissionQueue,
    audit: sshAudit,
    outputLimitBytes: () => (
      Math.max(4, Math.min(1_024, Number(fastify.pluginSettings?.('ssh')?.outputLimitKiB) || 64))
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
    fastify.sse.broadcast('ssh-sessions', { sessionId: event.session.id });
  });

  const sshService = {
    listConnections: () => sshConnections.list(),
    createConnection: (input) => sshConnections.create(input),
    updateConnection: (id, input) => sshConnections.update(id, input),
    async deleteConnection(id) {
      await Promise.all(sshSessions.list()
        .filter((session) => session.connectionId === id)
        .map((session) => sshSessions.close(session.id)));
      return sshConnections.remove(id);
    },
    async probeHostKey(id) {
      const connection = sshConnections.get(id);
      if (!connection) {
        const error = new Error('SSH-соединение не найдено');
        error.code = 'not_found';
        throw error;
      }
      return sshHostKeys.check(await sshTransport.probe(connection));
    },
    decideHostKey: (challengeId, decision) => sshHostKeys.decide(challengeId, decision),
    async openSession(id, password) {
      const connection = sshConnections.get(id);
      if (!connection) {
        const error = new Error('SSH-соединение не найдено');
        error.code = 'not_found';
        throw error;
      }
      const trusted = sshHostKeys.get(connection.host, connection.port);
      if (!trusted) {
        const error = new Error('Сначала подтвердите host key');
        error.code = 'trust_required';
        throw error;
      }
      const session = await sshSessions.open({
        connection,
        password,
        hostVerifier: (fingerprint) => fingerprint === trusted.fingerprint,
      });
      return { session };
    },
    listSessions: () => sshSessions.list(),
    setAgentAccess: (id, allowed) => sshSessions.setAgentAccess(id, allowed),
    closeSession: (id) => sshSessions.close(id),
    attachTerminal: (id, socket) => sshSessions.attach(id, socket),
    writeTerminal: (id, data) => sshSessions.write(id, data),
    resizeTerminal: (id, cols, rows) => sshSessions.resize(id, cols, rows),
    listFiles: (id, remotePath) => sshSessions.listFiles(id, remotePath),
    downloadFile: (id, remotePath) => sshSessions.downloadFile(id, remotePath),
    async uploadFile(id, request) {
      const part = await request.file();
      if (!part) {
        const error = new Error('Файл не передан');
        error.code = 'invalid_connection';
        throw error;
      }
      const remotePath = String(part.fields?.path?.value || part.filename || '');
      return sshSessions.uploadFile(id, remotePath, part.file);
    },
    listAudit: (query) => sshAuditStore.list(query),
    answerApproval: (pid, body) => permissionQueue.answer(pid, 'ssh', body),
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
    async append(entry) {
      const result = await dbAuditStore.append(entry);
      fastify.sse.broadcast('db-audit', { at: result.at });
      return result;
    },
  };
  const dbSessions = createDbSessionManager({
    engines: dbEngines,
    sshSessions,
    permissionQueue,
    idleMs: () => (
      Math.max(1, Number(fastify.pluginSettings?.('db')?.idleCloseMinutes) || 15) * 60_000
    ),
  });
  const dbSettings = () => {
    const value = fastify.pluginSettings?.('db') || {};
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
      const value = fastify.pluginSettings?.('docker') || {};
      return {
        allowVolumeRemoval: value.allowVolumeRemoval === true,
        allowImagePruneAll: value.allowImagePruneAll === true,
        allowExec: value.allowExec !== false,
        logTailLines: Math.max(50, Number(value.logTailLines) || 500),
      };
    },
  });

  const dbQueries = new Map();

  function publicDbQuery(query) {
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

  function updateDbQuery(event) {
    const current = dbQueries.get(event.id);
    if (current?.state === 'cancelled' && event.state !== 'cancelled') return;
    dbQueries.set(event.id, { ...current, ...event });
    fastify.sse.broadcast('db-queries', { queryId: event.id });
  }

  const dbBroker = createDbBroker({
    pluginEnabled: (id) => fastify.pluginEnabled?.(id) === true,
    sessions: dbSessions,
    engines: dbEngines,
    permissionQueue,
    audit: dbAudit,
    settings: dbSettings,
    onQuery: updateDbQuery,
  });
  fastify.decorate('dbBroker', dbBroker);

  dbSessions.subscribe((event) => {
    fastify.sse.broadcast('db-sessions', { sessionId: event.session.id });
  });

  const dbService = {
    listEngines: () => dbEngines.list(),
    listProfiles: () => dbProfiles.list(),
    createProfile: (input) => dbProfiles.create(input),
    updateProfile: (id, input) => dbProfiles.update(id, input),
    async deleteProfile(id) {
      await Promise.all(dbSessions.list().filter((session) => session.profileId === id)
        .map((session) => dbSessions.close(session.id, 'profile_deleted')));
      return dbProfiles.remove(id);
    },
    async openSession(id, password, sshSessionId) {
      const profile = dbProfiles.get(id);
      if (!profile) {
        const error = new Error('Профиль БД не найден');
        error.code = 'not_found';
        throw error;
      }
      return { session: await dbSessions.open({ profile, password, sshSessionId }) };
    },
    listSessions: () => dbSessions.list(),
    setAgentAccess: (id, allowed) => dbSessions.setAgentAccess(id, allowed),
    closeSession: (id) => dbSessions.close(id),
    async schema(id) {
      const session = dbSessions.find(id);
      if (!session) {
        const error = new Error('DB-сессия не найдена');
        error.code = 'session_not_found';
        throw error;
      }
      const raw = await session.engine.schema(session.handle);
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
    async query(id, input) {
      const session = dbSessions.find(id);
      if (!session) {
        const error = new Error('DB-сессия не найдена');
        error.code = 'session_not_found';
        throw error;
      }
      const query = {
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
      fastify.sse.broadcast('db-queries', { queryId: query.id });
      Promise.resolve().then(async () => {
        try {
          const raw = await session.engine.execute(session.handle, {
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
            rows: query.result.totalRows,
            bytes: query.result.totalBytes,
            truncated: query.result.truncated,
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
          untrack?.();
          fastify.sse.broadcast('db-queries', { queryId: query.id });
        }
      });
      return { queryId: query.id };
    },
    listQueries: () => [...dbQueries.values()].map(publicDbQuery),
    getQuery: (id) => publicDbQuery(dbQueries.get(id)),
    async cancelQuery(id) {
      const query = dbQueries.get(id);
      const session = query ? dbSessions.find(query.sessionId) : null;
      const outcome = await cancelDbQuery({ query, session, sessions: dbSessions });
      if (!outcome.ok) return outcome;
      query.state = 'cancelled';
      query.finishedAt = new Date().toISOString();
      fastify.sse.broadcast('db-queries', { queryId: query.id });
      return { ok: true, method: outcome.method };
    },
    listAudit: (query) => dbAuditStore.list(query),
    answerApproval: (pid, body) => permissionQueue.answer(pid, 'db', body),
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
    log: fastify.log,
  });
  const githubBindings = new GitHubAccountBindings({
    file: path.join(config.githubDir, 'account-bindings.json'),
  });
  const githubCredentials = new GitHubCredentialsStore({ file: config.githubCredsPath });
  const githubAccountContextFor = createGitHubAccountContextFactory({ dir: config.githubDir });
  const claudeAuth = new ClaudeAuthStore({ authPath: config.claudeAuthPath });
  const b24 = new B24Adapter({ credsStore, cookiePath: config.b24CookiePath });
  // Идентичность компаньона можно создать и для запущенной задачи фабрики, и для
  // существующей задачи Б24 до запуска. Подтвердить её имеют право только эти серверные источники;
  // для быстрого хода модуль чата отдельно требует точное рабочее дерево фабрики.
  const companionTaskExists = async (taskId) => {
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
  speechRuntime.applyRuntimeSettings(prefs.read().speech);
  const media = new MediaAdapter({ mediaDir: config.mediaDir, speechRuntime });
  const inboxAttachmentAnalyzer = new InboxAttachmentAnalyzer({
    cacheDir: path.join(config.mediaDir, 'inbox-attachment-analysis'),
    // Расшифровка зависит от языка, модели и hotwords. При их изменении старый
    // кэш нельзя повторно использовать для новой задачи.
    revision: () => JSON.stringify(prefs.read().speech || {}),
    transcribe: ({ filePath, signal }) => speechRuntime.transcribe({
      filePath,
      settings: prefs.read().speech,
      signal,
    }),
    extractFrames: (options) => extractSceneFrames(options),
  });
  const notifyInboxChanged = (payload) => fastify.sse?.broadcast?.('inbox-changed', payload);
  const telegramConnection = new TelegramConnection({
    credentials: telegramCredentials,
    bindings: telegramBindings,
    accountContextFor: telegramAccountContextFor,
    botApi: telegramBotApi,
    enabled: () => fastify.pluginEnabled?.('telegram') === true,
    onChanged: notifyInboxChanged,
    log: fastify.log,
  });
  // Телеграм-пульт собирается ниже, после регистрации модулей (ему нужен inject
  // по готовым ручкам); поллер получает late-bound ссылку — сообщения и нажатия
  // начинают обрабатываться, как только runtime собран.
  let telegramPult = null;
  // Одна исходящая очередь на бота: у пульта единый rate-limit domain.
  const pultQueue = new PultSendQueue();
  const telegramPoller = new TelegramAccountPoller({
    acquireLease: () => telegramConnection.acquireLease(),
    botApi: telegramBotApi,
    isEnabled: () => fastify.pluginEnabled?.('telegram') === true,
    onChanged: notifyInboxChanged,
    onMessage: (msg, type, lease) => telegramPult?.actions?.onMessage(msg, type, lease),
    onCallback: (callback, lease) => telegramPult?.actions?.onCallback(callback, lease),
    log: fastify.log,
  });
  telegramConnection.attachPoller(telegramPoller);
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
    acquireInboxLease: () => telegramConnection.acquireLease(),
    log: fastify.log,
  });
  const githubConnection = new GitHubConnection({
    credentials: githubCredentials,
    bindings: githubBindings,
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
    coordinator: inboxCoordinator,
    b24,
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
      photos: fastify.pluginSettings('inbox')?.attachPhotos !== false,
      videos: fastify.pluginSettings('inbox')?.attachVideos === true,
    }),
    attachmentTriage: ({ item, attachmentAnalysis, operatorNote }) => runInboxTriage({
      item,
      attachmentAnalysis,
      operatorNote,
      // Ручной путь: человек уже решил, что задача нужна, — модель формулирует
      // постановку, а не голосует заново.
      decided: true,
      modelRef: fastify.pluginSettings('inbox')?.triageModel ?? null,
      config,
      providerSettings: prefs.read().providerSettings || {},
      log: fastify.log,
    }),
    onChanged: notifyInboxChanged,
    log: fastify.log,
  });
  const inboxAutoTasks = new InboxAutoTasks({
    coordinator: inboxCoordinator,
    taskService: inboxTaskService,
    b24,
    attachmentAnalyzer: inboxAttachmentAnalyzer,
    modelRef: () => fastify.pluginSettings('inbox')?.triageModel ?? null,
    isEnabled: () => fastify.pluginEnabled('inbox'),
    config,
    providerSettings: () => prefs.read().providerSettings || {},
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
    discussion: (text, opts) => fastify.telegramDiscussion?.(text, opts),
    pluginEnabled: (id) => fastify.pluginEnabled?.(id) === true,
    pluginSettings: (id) => fastify.pluginSettings?.(id) || {},
    providerRegistry: () => fastify.providerRegistry?.() || {},
    executorFor: (id) => fastify.executorFor?.(id) || null,
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
  await fastify.register(factoryModule, {
    factoryState, config, prefs, b24, analyzer, internalToken, arbiterCards, arbiterLive,
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
    },
  });
  await fastify.register(knowledgeModule, { knowledge, transfer: knowledgeTransfer });
  await fastify.register(taskShelfModule, { shelf: taskShelf });
  await fastify.register(mediaModule, {
    media,
    speechRuntime,
    speechSettings: () => prefs.read().speech,
    config,
    // Модель разбора встречи — своя настройка плагина «Видео», читается перед самым
    // запуском: смена модели в настройках действует со следующего разбора, без рестарта.
    meetingModelRef: () => fastify.pluginSettings('video')?.triageModel ?? null,
    providerSettings: () => prefs.read().providerSettings || {},
  });
  await fastify.register(codeModule, { config, prefs });
  await fastify.register(githubModule, {
    connection: githubConnection,
    listProjects: () => listProjects(config, prefs),
  });
  await fastify.register(inboxModule, {
    coordinator: inboxCoordinator,
    taskService: inboxTaskService,
    worker: inboxAutoTasks,
  });
  await fastify.register(telegramModule, {
    connection: telegramConnection,
    poller: telegramPoller,
    botApi: telegramBotApi,
    listProjects: () => listProjects(config, prefs),
  });
  await fastify.register(documentsModule, { reader: documentReader });
  await fastify.register(projectsModule, { config, prefs });
  await fastify.register(sshModule, { service: sshService });
  await fastify.register(dbModule, { service: dbService });
  await fastify.register(dockerModule, { service: dockerService });
  await fastify.register(chatModule, {
    factoryState, config, claudeAuth, internalToken, prefs, speechRuntime,
    taskExists: companionTaskExists,
    permissionQueue,
    sshBroker,
    dbBroker,
    knowledgeBroker,
  });
  await fastify.register(settingsModule, {
    credsStore, b24, claudeAuth, config, prefs, factoryDebug, localTls, tlsRuntime,
    speechRuntime,
  });
  await fastify.register(terminalModule);
  await fastify.register(agentsModule, { config });
  await fastify.register(routesModule, { config, prefs });
  await fastify.register(providersModule, { config, claudeAuth, prefs });
  const analysisArbiter = new AnalysisArbiter({
    analyzer,
    pluginEnabled: (id) => fastify.pluginEnabled(id),
    pluginSettings: (id) => fastify.pluginSettings(id),
    providerRegistry: () => fastify.providerRegistry(),
    executorFor: (id) => fastify.executorFor(id),
    log: fastify.log,
  });
  analyzer.onAnalyzed = (id) => analysisArbiter.arbitrate(id, { automatic: true });
  await analyzer.start();
  await fastify.register(analysisModule, { analyzer, arbiter: analysisArbiter });

  // Статика — последней (SPA-fallback перехватывает не-API 404).
  await fastify.register(staticPlugin, { webDist: config.webDist, stateDir: config.stateDir });

  // ── Телеграм-пульт: вотчер «требует человека» + команды/кнопки владельца ──
  // Пульт — ещё одно «окно» кокпита: действия идут через inject в те же ручки,
  // что жмёт браузер (X-Cockpit-Internal — как у permission-mcp чата).
  const pultCallApi = async (method, url, payload) => {
    const res = await fastify.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { 'x-cockpit-internal': internalToken },
    });
    let body = null;
    try { body = res.json(); } catch { /* не-JSON ответа у этих ручек не бывает */ }
    return { statusCode: res.statusCode, body };
  };
  const pultStores = new Map();
  // Одна фабрика state на вотчер и действия: карточки, экран навигации и реестр
  // служебных ответов живут в одном pult-state.json (merge-запись по полям).
  const pultStateStoreFor = (lease) => {
    const file = path.join(lease.context.paths.accountDir, 'pult-state.json');
    if (!pultStores.has(file)) {
      pultStores.set(file, new TelegramPultStateStore({ file, log: fastify.log }));
    }
    return pultStores.get(file);
  };
  const pultWatch = new TelegramPultWatch({
    acquireLease: () => telegramConnection.acquireLease(),
    isEnabled: () => fastify.pluginEnabled?.('telegram') === true,
    callApi: pultCallApi,
    stateStoreFor: pultStateStoreFor,
    queue: pultQueue,
    subscribe: (listener) => fastify.sse.subscribe(listener),
    log: fastify.log,
  });
  telegramPult = {
    watch: pultWatch,
    actions: new TelegramPultActions({
      isEnabled: () => fastify.pluginEnabled?.('telegram') === true,
      callApi: pultCallApi,
      summary: () => pultWatch.statusSnapshot(),
      forget: (key) => pultWatch.forget(key),
      stateStoreFor: pultStateStoreFor,
      acquireLease: () => telegramConnection.acquireLease(),
      subscribe: (listener) => fastify.sse.subscribe(listener),
      speechRuntime,
      readSpeechPrefs: () => prefs.read().speech,
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
    sse: { subscribe: (listener) => fastify.sse.subscribe(listener) },
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
    arbitrate: (task, reply) => fastify.factoryArbitrate(task, reply, { actor: 'auto' }),
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
    void telegramPult.actions.start().catch((error) => {
      fastify.log.warn({ err: error }, 'telegram-pult: восстановление после старта сорвалось');
    });
    arbiterWatch.start();
  });
  fastify.addHook('onClose', async () => {
    githubConnection.stop();
    telegramPult.actions.stop();
    await telegramPoller.stop();
    await pultWatch.stop();
    inboxAutoTasks.stop();
    arbiterWatch.stop();
    await speechRuntime.shutdown();
  });

  // Второй сокет закрываем вместе с сервером: иначе `bin/restart` поднимет новый процесс,
  // а тот упрётся в EADDRINUSE на порту, который скрипт даже не проверяет.
  fastify.addHook('onClose', async () => {
    if (!tlsRuntime.server) return;
    await new Promise((resolve) => tlsRuntime.server.close(resolve));
    tlsRuntime.server = null;
    tlsRuntime.up = false;
  });

  return fastify;
}

/**
 * Поднять https и записать результат в `tlsRuntime` — от него зависит область http-сокета.
 * Вызывать ПОСЛЕ `listen()`: до готовности приложения плагин вебсокета ещё не повесил upgrade.
 */
async function startHttps(app) {
  if (!tlsLoaded.key) {
    if (tlsRuntime.error) {
      app.log.error(`HTTPS не поднят: ${tlsRuntime.error}. Кокпит работает по http — сертификат можно перевыпустить в «Настройки → Доступ».`);
    }
    return;
  }
  const result = await startHttpsListener({
    app, key: tlsLoaded.key, cert: tlsLoaded.cert, port: config.tlsPort, host: config.host,
  });
  if (!result.ok) {
    // Занятый порт или отказ в биндинге — не повод убивать процесс: http живёт, UI доступен
    // с мозга, причина видна в «Настройки → Доступ».
    tlsRuntime.error = result.error;
    app.log.error(`HTTPS не поднят на :${config.tlsPort}: ${result.error}`);
    return;
  }
  tlsRuntime.server = result.server;
  tlsRuntime.up = true;
  tlsRuntime.fingerprint = tlsLoaded.fingerprint;
  app.log.info(`HTTPS слушает :${config.tlsPort} (сертификат из «${tlsLoaded.source}»); http на :${config.port} — loopback и корневой сертификат.`);
}

const app = await build();
try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
await startHttps(app);
