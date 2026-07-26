// Ядро сервера кокпита. Явная сборка: конфиг → адаптеры → плагины → модули → listen.
// Никакой автозагрузки (YAGNI): модули регистрируются списком, зависимости передаём явно.
import { readFileSync } from 'node:fs';
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
import { Analyzer } from './lib/analysis/analyzer.js';

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
  const factoryState = new FactoryStateAdapter({ stateDir: config.stateDir, factoryHome: config.factoryHome });
  const credsStore = new CredsStore({ credsPath: config.b24CredsPath, baseUrl: config.b24BaseUrl });
  const claudeAuth = new ClaudeAuthStore({ authPath: config.claudeAuthPath });
  const b24 = new B24Adapter({ credsStore, cookiePath: config.b24CookiePath });
  const system = new SystemAdapter();
  const media = new MediaAdapter({ mediaDir: config.mediaDir });
  const prefs = new PrefsStore({ prefsPath: config.prefsPath });
  const analyzer = new Analyzer({ config, claudeAuth, b24, factoryState, prefs, log: fastify.log });
  const authStore = new AuthStore({
    accountPath: config.authAccountPath,
    sessionsPath: config.authSessionsPath,
  });

  // Секрет ЭТОГО процесса для внутренних запросов: permission-prompt-tool чата работает
  // в дочернем процессе claude (cookie у него нет), но обязан достучаться до сервера.
  // Живёт только в памяти, на диск и в конфиг не попадает, меняется с каждым запуском.
  const internalToken = randomUUID();

  // Плагины платформы. Гард — первым: он закрывает весь /api, включая upgrade вебсокета.
  await fastify.register(authPlugin, { authStore, tlsEnabled: !!https, trustProxy: config.trustProxy, internalToken });
  await fastify.register(ssePlugin, { stateDir: config.stateDir });

  // Модули.
  await fastify.register(authModule, { authStore, config });
  await fastify.register(gatewayModule, { config });
  await fastify.register(healthModule, { config, factoryState });
  await fastify.register(factoryModule, { factoryState, config, prefs });
  await fastify.register(b24Module, { b24 });
  await fastify.register(systemModule, { system });
  await fastify.register(mediaModule, { media });
  await fastify.register(chatModule, { factoryState, config, claudeAuth, internalToken });
  await fastify.register(settingsModule, { credsStore, b24, claudeAuth, config, prefs });
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
