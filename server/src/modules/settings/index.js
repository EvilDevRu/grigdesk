// Модуль settings — редактирование кредов B24 из «Настроек» + проверка авторизации.
// Кокпит хранит креды у себя (единственный владелец сессии).
import fp from 'fastify-plugin';

async function settingsModule(fastify, opts) {
  const { credsStore, b24 } = opts;

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
