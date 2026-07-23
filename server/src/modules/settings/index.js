// Модуль settings — редактирование кредов B24 из «Настроек» + проверка авторизации.
// Кокпит хранит креды у себя (единственный владелец сессии).
import fp from 'fastify-plugin';

import { execFile } from 'node:child_process';

async function settingsModule(fastify, opts) {
  const { credsStore, b24, claudeAuth, config } = opts;

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

  // ── Авторизация Claude (для чата с агентами) ──

  // Статус: режим (свой ключ / CLI хоста / env / нет), подсказка ключа, залогинен ли хост.
  fastify.get('/api/settings/claude', async () => claudeAuth.publicView());

  // Задать/очистить собственный API-ключ кокпита. Пустой ключ → очистка (вернуться к CLI хоста).
  fastify.post('/api/settings/claude', async (request, reply) => {
    const { apiKey } = request.body || {};
    if (apiKey && apiKey.trim()) claudeAuth.write(apiKey);
    else claudeAuth.clear();
    return claudeAuth.publicView();
  });

  // Проверка: гоняем короткий claude-пинг на дешёвой модели с текущей авторизацией.
  fastify.post('/api/settings/claude/test', async () => new Promise((resolve) => {
    const args = ['-p', 'reply with exactly: OK', '--output-format', 'json', '--model', 'haiku', '--permission-mode', 'plan'];
    execFile(config.claudeBin, args, { env: claudeAuth.env(), cwd: config.factoryHome, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ok: false, error: (stderr || err.message).slice(-300) });
      try {
        const j = JSON.parse(stdout);
        resolve({ ok: !j.is_error, reply: (j.result || '').slice(0, 80), cost: j.total_cost_usd ?? null });
      } catch { resolve({ ok: false, error: 'не разобрать ответ claude' }); }
    });
  }));
}

export default fp(settingsModule, { name: 'module-settings' });
