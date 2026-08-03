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
import { TaskFavoritesStore } from './lib/task-favorites-store.js';
import { TaskFavoritesService } from './lib/task-favorites-service.js';

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
  });
  const credsStore = new CredsStore({ credsPath: config.b24CredsPath, baseUrl: config.b24BaseUrl });
  const claudeAuth = new ClaudeAuthStore({ authPath: config.claudeAuthPath });
  const b24 = new B24Adapter({ credsStore, cookiePath: config.b24CookiePath });
  const system = new SystemAdapter();
  const media = new MediaAdapter({ mediaDir: config.mediaDir });
  const taskFavoritesStore = new TaskFavoritesStore({ filePath: config.taskFavoritesPath });
  const taskFavorites = new TaskFavoritesService({ store: taskFavoritesStore, b24 });
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
  await fastify.register(gatewayModule, { config });
  await fastify.register(healthModule, { config, factoryState });
  await fastify.register(factoryModule, { factoryState, config, prefs, b24, analyzer });
  await fastify.register(b24Module, { b24 });
  await fastify.register(taskFavoritesModule, { favorites: taskFavorites });
  await fastify.register(systemModule, { system, config });
  // Реестр плагинов — ДО модулей-плагинов: они гейтят роуты через fastify.pluginEnabled().
  await fastify.register(pluginsModule, { config, prefs });
  await fastify.register(mediaModule, { media });
  await fastify.register(codeModule, { config, prefs });
  await fastify.register(documentsModule, { reader: documentReader });
  await fastify.register(projectsModule, { config, prefs });
  await fastify.register(chatModule, {
    factoryState, config, claudeAuth, internalToken, prefs,
  });
  await fastify.register(settingsModule, {
    credsStore, b24, claudeAuth, config, prefs, factoryDebug, localTls, tlsRuntime,
  });
  await fastify.register(terminalModule);
  await fastify.register(agentsModule, { config });
  await fastify.register(routesModule, { config, prefs });
  await fastify.register(providersModule, { config, claudeAuth, prefs });
  await fastify.register(analysisModule, { analyzer });

  // Статика — последней (SPA-fallback перехватывает не-API 404).
  await fastify.register(staticPlugin, { webDist: config.webDist, stateDir: config.stateDir });

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
