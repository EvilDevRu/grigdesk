// Ядро сервера кокпита. Явная сборка: конфиг → адаптеры → плагины → модули → listen.
// Никакой автозагрузки (YAGNI): модули регистрируются списком, зависимости передаём явно.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import { config } from './config.js';
import { FactoryStateAdapter } from './adapters/factory-state.js';
import { B24Adapter } from './adapters/b24.js';
import { SystemAdapter } from './adapters/system.js';
import { MediaAdapter } from './adapters/media.js';
import { CredsStore } from './lib/b24/creds-store.js';
import { ClaudeAuthStore } from './lib/claude-auth-store.js';

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

async function build() {
  const fastify = Fastify({
    logger: { level: config.isDev ? 'debug' : 'info' },
  });

  // CORS нужен только в dev (vite на другом порту). В проде фронт — тот же origin.
  if (config.isDev) {
    await fastify.register(cors, { origin: true });
  }

  // Загрузка видео/аудио для распознавания (до 3 ГБ).
  await fastify.register(multipart, { limits: { fileSize: 3 * 1024 ** 3 } });

  // Адаптеры (изоляция источников).
  const factoryState = new FactoryStateAdapter({ stateDir: config.stateDir, factoryHome: config.factoryHome });
  const credsStore = new CredsStore({ credsPath: config.b24CredsPath, baseUrl: config.b24BaseUrl });
  const claudeAuth = new ClaudeAuthStore({ authPath: config.claudeAuthPath });
  const b24 = new B24Adapter({ credsStore, cookiePath: config.b24CookiePath });
  const system = new SystemAdapter();
  const media = new MediaAdapter({ mediaDir: config.mediaDir });

  // Плагины платформы.
  await fastify.register(authPlugin, { mutateToken: config.mutateToken });
  await fastify.register(ssePlugin, { stateDir: config.stateDir });

  // Модули.
  await fastify.register(healthModule, { config, factoryState });
  await fastify.register(factoryModule, { factoryState, config });
  await fastify.register(b24Module, { b24 });
  await fastify.register(systemModule, { system });
  await fastify.register(mediaModule, { media });
  await fastify.register(chatModule, { factoryState, config, claudeAuth });
  await fastify.register(settingsModule, { credsStore, b24, claudeAuth, config });

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
