// Модуль settings — редактирование кредов B24 из «Настроек» + проверка авторизации.
// Кокпит хранит креды у себя (единственный владелец сессии).
// Авторизация Claude настраивается не здесь: чат использует хостовый CLI (claude login),
// статус исполнителей отдаёт реестр /api/providers.
import fp from 'fastify-plugin';
import { FactoryDebugInputError } from '../../lib/factory-debug.js';
import {
  TrustedDirectoryInputError,
  validateTrustedDirectories,
} from '../../lib/trusted-directories.js';

async function settingsModule(fastify, opts) {
  const { credsStore, b24, prefs, factoryDebug } = opts;

  // Общие настройки кокпита (правила запусков и пр.).
  fastify.get('/api/settings/prefs', async () => prefs.read());
  fastify.post('/api/settings/prefs', async (request) => prefs.write(request.body || {}));

  // Единый список дополнительных деревьев для всех локальных ИИ. Мы не переписываем
  // ~/.claude и ~/.codex: проверенный список добавляется флагами к каждому новому ходу.
  fastify.post('/api/settings/trusted-directories', async (request, reply) => {
    try {
      const directories = await validateTrustedDirectories(request.body?.directories);
      prefs.write({ trustedDirectories: directories });
      return { directories };
    } catch (err) {
      if (err instanceof TrustedDirectoryInputError) {
        return reply.code(400).send({ error: 'bad_trusted_directory', message: err.message });
      }
      throw err;
    }
  });

  // Диагностические логи фабрики. Источник истины — engine CLI: сервер не читает и
  // не пишет его settings-файлы сам.
  fastify.get('/api/settings/factory-debug', async (request, reply) => {
    const { scope = 'global', profile, task } = request.query || {};
    try {
      return await factoryDebug.show({ scope, profile, task });
    } catch (err) {
      if (err instanceof FactoryDebugInputError) {
        return reply.code(400).send({ error: 'bad_debug_setting', message: err.message });
      }
      return reply.code(502).send({ error: 'factory_debug_failed', message: err.message });
    }
  });

  fastify.post('/api/settings/factory-debug', async (request, reply) => {
    const {
      scope = 'global', profile, task, level, duration, clear = false,
    } = request.body || {};
    try {
      if (clear) return await factoryDebug.clear({ scope, profile, task });
      return await factoryDebug.set({ scope, profile, task, level, duration });
    } catch (err) {
      if (err instanceof FactoryDebugInputError) {
        return reply.code(400).send({ error: 'bad_debug_setting', message: err.message });
      }
      return reply.code(502).send({ error: 'factory_debug_failed', message: err.message });
    }
  });

  // Текущие настройки B24 (без пароля).
  fastify.get('/api/settings/b24', async () => credsStore.publicView());

  // Сохранить креды. Мутация (нужен токен, если настроен).
  fastify.post('/api/settings/b24', async (request, reply) => {
    const { login, password, baseUrl } = request.body || {};
    if (!login || !password) {
      return reply.code(400).send({ error: 'bad_input', message: 'Укажите логин и пароль.' });
    }
    credsStore.write({ login, password, baseUrl });
    b24.invalidate(); // пересобрать клиент под новые креды
    return credsStore.publicView();
  });

  // Проверить авторизацию: логинимся, возвращаем результат.
  fastify.post('/api/settings/b24/test', async () => b24.testAuth());
}

export default fp(settingsModule, { name: 'module-settings' });
