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
import { AuthStore } from './lib/auth-store.js';
import { FactoryStateAdapter } from './adapters/factory-state.js';
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
import { runInboxTriage } from './lib/inbox/triage.js';
import { FactoryDebugSettings } from './lib/factory-debug.js';
import { readRouteWorkTime } from './lib/factory-route-cli.js';
import { TaskFavoritesStore } from './lib/task-favorites-store.js';
import { TaskFavoritesService } from './lib/task-favorites-service.js';
import { TaskSeenStore } from './lib/task-seen-store.js';
import { TaskSeenService } from './lib/task-seen-service.js';

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
import { Analyzer } from './lib/analysis/analyzer.js';
import { DocumentReader } from './lib/documents/reader.js';

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

  // CORS нужен только в dev (vite на другом порту). В проде фронт — тот же origin.
  if (config.isDev) {
    await fastify.register(cors, { origin: true });
  }

  // Загрузка видео/аудио для распознавания (до 3 ГБ).
  await fastify.register(multipart, { limits: { fileSize: 3 * 1024 ** 3 } });

  // WebSocket — для терминала (PTY-поток). maxPayload скромный: терминал — не файлы.
  await fastify.register(websocket, { options: { maxPayload: 1 * 1024 ** 2 } });

  // Адаптеры (изоляция источников).
  const factoryState = new FactoryStateAdapter({
    stateDir: config.stateDir,
    routesDir: config.routesDir,
    profilesDir: config.profilesDir,
    controlDir: config.factoryControlDir,
    workTimeReader: (identity) => readRouteWorkTime(config, identity),
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
    factoryState, config, prefs, b24, analyzer, internalToken,
  });
  await fastify.register(b24Module, { b24 });
  await fastify.register(taskFavoritesModule, { favorites: taskFavorites });
  await fastify.register(taskSeenModule, { seen: taskSeen });
  await fastify.register(systemModule, { system, config });
  // Реестр плагинов — ДО модулей-плагинов: они гейтят роуты через fastify.pluginEnabled().
  await fastify.register(pluginsModule, { config, prefs });
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
  await fastify.register(chatModule, {
    factoryState, config, claudeAuth, internalToken, prefs, speechRuntime,
    taskExists: companionTaskExists,
  });
  await fastify.register(settingsModule, {
    credsStore, b24, claudeAuth, config, prefs, factoryDebug, localTls, tlsRuntime,
    speechRuntime,
  });
  await fastify.register(terminalModule);
  await fastify.register(agentsModule, { config });
  await fastify.register(routesModule, { config, prefs });
  await fastify.register(providersModule, { config, claudeAuth, prefs });
  await fastify.register(analysisModule, { analyzer });

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
      const response = await fastify.inject({ method: 'GET', url: '/api/tasks' });
      if (response.statusCode !== 200) return [];
      return response.json().tasks || [];
    },
    arbitrate: (task, reply) => fastify.factoryArbitrate(task, reply),
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
