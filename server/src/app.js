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
import { CredsStore } from './lib/b24/creds-store.js';
import { ClaudeAuthStore } from './lib/claude-auth-store.js';
import { PrefsStore } from './lib/prefs-store.js';
import { FactoryDebugSettings } from './lib/factory-debug.js';

import authPlugin from './plugins/auth.js';
import ssePlugin from './plugins/sse.js';
import staticPlugin from './plugins/static.js';

import healthModule from './modules/health/index.js';
import factoryModule from './modules/factory/index.js';
import b24Module from './modules/b24/index.js';
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
import demoModule from './modules/demo/index.js';
import projectsModule from './modules/projects/index.js';
import codeModule from './modules/code/index.js';
import { Analyzer } from './lib/analysis/analyzer.js';
import { ReviewStore } from './lib/reviews/store.js';
import { ReviewControlStore } from './lib/reviews/control-store.js';
import { createGhRunner, GitHubReviewAdapter } from './lib/reviews/github.js';
import { ReviewAnalysisQueue } from './lib/reviews/analyzer.js';
import { ReviewTranslatorQueue } from './lib/reviews/translator.js';
import { ReviewWatcher } from './lib/reviews/watcher.js';
import { createReviewModelAdapter } from './lib/reviews/model-adapter.js';
import { createReviewBuildAgent } from './lib/reviews/build-agent.js';
import { createReviewRunner } from './lib/reviews/runner.js';
import { createReviewPublisher } from './lib/reviews/publisher.js';
import { createDegradedReviewService } from './lib/reviews/degraded.js';
import {
  ReviewService,
  createReviewRepositoryProvider,
  createReviewSourceSnapshot,
} from './lib/reviews/service.js';
import reviewsModule from './modules/reviews/index.js';

/**
 * Опции TLS, если сертификат задан в конфиге. Читаем синхронно на старте: без сертификата
 * сервер поднимать нельзя, а падать надо сразу с понятной ошибкой, а не на первом запросе.
 */
function tlsOptions() {
  if (!config.tlsKeyPath || !config.tlsCertPath) return null;
  try {
    return { key: readFileSync(config.tlsKeyPath), cert: readFileSync(config.tlsCertPath) };
  } catch (err) {
    throw new Error(`Не читается TLS-сертификат (COCKPIT_TLS_KEY / COCKPIT_TLS_CERT): ${err.message}`);
  }
}

async function build() {
  const https = tlsOptions();
  const fastify = Fastify({
    logger: { level: config.isDev ? 'debug' : 'info' },
    ...(https ? { https } : {}),
    // trustProxy — только по явной настройке и только для адреса шлюза (см. config.trustProxy).
    // Без неё заголовки `X-Forwarded-*` игнорируются: иначе клиент сам назначал бы себе адрес.
    ...(config.trustProxy ? { trustProxy: config.trustProxy } : {}),
    // Дефолтного мегабайта fastify хватало ровно до того дня, когда история чатов доросла
    // до него: PUT /api/chat/store начал отвечать 413, клиент молча ретраил каждые 15 с —
    // и переписка перестала сохраняться совсем (терялась на F5 и «стопе»). Тело чатов
    // теперь режется на отдельные запросы (store/chat), а этот лимит — общая страховка.
    bodyLimit: 64 * 1024 ** 2,
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
    profilesDir: config.profilesDir,
  });
  const credsStore = new CredsStore({ credsPath: config.b24CredsPath, baseUrl: config.b24BaseUrl });
  const claudeAuth = new ClaudeAuthStore({ authPath: config.claudeAuthPath });
  const b24 = new B24Adapter({ credsStore, cookiePath: config.b24CookiePath });
  const system = new SystemAdapter();
  const media = new MediaAdapter({ mediaDir: config.mediaDir });
  const prefs = new PrefsStore({ prefsPath: config.prefsPath });
  const factoryDebug = new FactoryDebugSettings({
    factoryBin: config.factoryBin,
    stateDir: config.stateDir,
    configRoot: config.factoryConfigRoot,
    profilesDir: config.profilesDir,
  });
  const analyzer = new Analyzer({ config, claudeAuth, b24, factoryState, prefs, log: fastify.log });
  const authStore = new AuthStore({
    accountPath: config.authAccountPath,
    sessionsPath: config.authSessionsPath,
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

  // Плагины платформы. Гард — первым: он закрывает весь /api, включая upgrade вебсокета.
  await fastify.register(authPlugin, { authStore, tlsEnabled: !!https, trustProxy: config.trustProxy, internalToken, cliToken });
  await fastify.register(ssePlugin, { stateDir: config.stateDir });

  // Автоматическое ревью — отдельный durable-контур. Он не использует номера
  // задач Factory и не трогает t<TASK>.pipeline.
  const reviewStore = new ReviewStore({ stateDir: config.reviewsDir });
  const reviewControl = new ReviewControlStore({ stateDir: config.reviewsDir });
  const reviewRepositories = createReviewRepositoryProvider({ config, prefs });
  const reviewModel = createReviewModelAdapter({ config });
  const reviewTranslator = new ReviewTranslatorQueue({
    store: reviewStore,
    model: reviewModel,
  });
  const reviewAnalysis = new ReviewAnalysisQueue({
    store: reviewStore,
    model: reviewModel,
    translatorQueue: reviewTranslator,
  });
  const reviewGitHub = new GitHubReviewAdapter({
    runner: createGhRunner(),
    log: fastify.log,
  });
  const reviewRunner = createReviewRunner({
    stateDir: config.reviewsDir,
    worktreeRoot: path.join(config.reviewsDir, 'worktrees'),
    agentAdapter: createReviewBuildAgent({ config }),
  });
  let reviews = null;
  const reviewPublisher = createReviewPublisher({
    store: reviewRunner.store,
    beforePush: (state) => reviews.revalidatePublication(state),
  });
  const reviewWatcher = new ReviewWatcher({
    store: reviewStore,
    github: reviewGitHub,
    repositories: reviewRepositories,
    analysisQueue: reviewAnalysis,
    sourceSnapshot: createReviewSourceSnapshot,
    intervalMs: config.reviewPollMs,
    coalesceMs: config.reviewDebounceMs,
    log: fastify.log,
    onChange: (event) => fastify.sse.broadcast('reviews-change', {
      at: Date.now(),
      ...event,
    }),
  });
  const activeReviews = new ReviewService({
    store: reviewStore,
    controlStore: reviewControl,
    watcher: reviewWatcher,
    analysisQueue: reviewAnalysis,
    translatorQueue: reviewTranslator,
    runner: reviewRunner,
    publisher: reviewPublisher,
    repositoryProvider: reviewRepositories,
    sse: fastify.sse,
    log: fastify.log,
    modelConcurrency: config.reviewAnalysisConcurrency,
  });
  reviews = activeReviews;
  try {
    await activeReviews.init();
  } catch (error) {
    fastify.log.error({
      code: error?.code,
      err: error?.message,
    }, 'Review subsystem запущена в degraded-режиме');
    await activeReviews.close().catch(() => {});
    reviews = createDegradedReviewService(error);
  }
  fastify.addHook('onClose', async () => reviews.close());

  // Модули.
  await fastify.register(authModule, { authStore, config });
  await fastify.register(gatewayModule, { config });
  await fastify.register(healthModule, { config, factoryState });
  await fastify.register(factoryModule, { factoryState, config, prefs, b24, analyzer });
  await fastify.register(b24Module, { b24 });
  await fastify.register(systemModule, { system, config });
  // Реестр плагинов — ДО модулей-плагинов: они гейтят роуты через fastify.pluginEnabled().
  await fastify.register(pluginsModule, { config, prefs });
  await fastify.register(mediaModule, { media });
  await fastify.register(demoModule, { config, factoryState });
  await fastify.register(codeModule, { config, prefs });
  await fastify.register(projectsModule, { config, prefs, reviews });
  await fastify.register(reviewsModule, { reviews });
  await fastify.register(chatModule, {
    factoryState, config, claudeAuth, internalToken, prefs,
  });
  await fastify.register(settingsModule, {
    credsStore, b24, claudeAuth, config, prefs, factoryDebug,
  });
  await fastify.register(terminalModule);
  await fastify.register(agentsModule, { config });
  await fastify.register(routesModule, { config });
  await fastify.register(providersModule, { config, claudeAuth, prefs });
  await fastify.register(analysisModule, { analyzer });

  // Статика — последней (SPA-fallback перехватывает не-API 404).
  await fastify.register(staticPlugin, { webDist: config.webDist, stateDir: config.stateDir });

  return fastify;
}

const app = await build();
try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
