// Модуль settings — редактирование кредов B24 из «Настроек» + проверка авторизации.
// Кокпит хранит креды у себя (единственный владелец сессии).
// Авторизация Claude настраивается не здесь: чат использует хостовый CLI (claude login),
// статус исполнителей отдаёт реестр /api/providers.
import fp from 'fastify-plugin';
import net from 'node:net';
import qrcode from 'qrcode-generator';
import { FactoryDebugInputError } from '../../lib/factory-debug.js';
import {
  TrustedDirectoryInputError,
  validateTrustedDirectories,
} from '../../lib/trusted-directories.js';
import { TlsInputError, isPrivateAddress } from '../../lib/tls/local.js';

async function settingsModule(fastify, opts) {
  const {
    credsStore, b24, prefs, factoryDebug, localTls, tlsRuntime,
  } = opts;

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

  // ── Локальный HTTPS ────────────────────────────────────────────────────────────────────
  // Тумблера «включить сейчас» здесь нет и быть не может: сертификат читается один раз при
  // создании сокета, поэтому выпуск вступает в силу только после перезапуска сервера.

  /** Адрес, который попадёт в QR и в подсказку «открыть по https». */
  function preferredAddress(request) {
    const asked = String(request.query?.address || '').trim();
    if (asked && net.isIP(asked) && isPrivateAddress(asked)) return asked;
    const state = localTls.readState();
    if (state?.addresses?.length) return state.addresses[0];
    return '';
  }

  /**
   * Корень и QR отдаём БЕЗ сессии, но только клиентам из локальной сети.
   *
   * Иначе получается ловушка: устройство, где кокпит ещё не открывали, по QR получит 401,
   * а поставить корень без этого файла нельзя. Сам корень — публичная часть сертификата,
   * секрета в нём нет; наружу через шлюз он всё равно не уходит (`request.ip` за доверенным
   * прокси — это адрес реального клиента, а не туннеля).
   */
  function requirePrivateClient(request, reply) {
    if (isPrivateAddress(request.ip)) return true;
    reply.code(401).send({
      error: 'unauthorized',
      message: 'Корневой сертификат отдаётся только в локальной сети.',
    });
    return false;
  }

  fastify.get('/api/settings/tls', async () => localTls.status(tlsRuntime));

  fastify.post('/api/settings/tls/generate', async (request, reply) => {
    try {
      // Сессии здесь НЕ сбрасываем: человек в этот момент стоит с планшетом посреди
      // установки корня, и разлогинить его — значит потребовать пароль по тому самому
      // непроверенному соединению, от которого мы уходим.
      const result = await localTls.generate({ addresses: request.body?.addresses });
      return { ok: true, ...result, status: await localTls.status(tlsRuntime) };
    } catch (err) {
      if (err instanceof TlsInputError) {
        return reply.code(400).send({ error: 'bad_tls_input', message: err.message });
      }
      return reply.code(500).send({ error: 'tls_generate_failed', message: err.message });
    }
  });

  fastify.get('/api/settings/tls/ca.crt', async (request, reply) => {
    if (!requirePrivateClient(request, reply)) return reply;
    try {
      const { pem } = localTls.caCertificate();
      return reply
        // Расширение и тип важны: установщик Android смотрит именно на них.
        .header('content-type', 'application/x-x509-ca-cert')
        .header('content-disposition', 'attachment; filename="cockpit-ca.crt"')
        .send(pem);
    } catch (err) {
      return reply.code(404).send({ error: 'no_ca', message: err.message });
    }
  });

  fastify.get('/api/settings/tls/ca.svg', async (request, reply) => {
    if (!requirePrivateClient(request, reply)) return reply;
    const address = preferredAddress(request);
    if (!address) {
      return reply.code(404).send({ error: 'no_ca', message: 'Сертификат ещё не выпущен.' });
    }
    // QR ведёт на HTTP-адрес: он работает и до перезапуска, и после (по нему http-сокет
    // отдаёт корень даже клиентам из сети). Веди он на https — корень пришлось бы качать
    // через то самое предупреждение браузера, которое он и убирает.
    const url = `http://${address}:${tlsRuntime.httpPort}/api/settings/tls/ca.crt`;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return reply
      .header('content-type', 'image/svg+xml')
      .header('cache-control', 'no-store')
      .send(qr.createSvgTag({ cellSize: 4, margin: 2 }));
  });

  fastify.post('/api/settings/tls/disable', async (request, reply) => {
    // Не DELETE: нужно тело с подтверждением — выключение роняет доступ с планшета.
    if (request.body?.confirm !== true) {
      return reply.code(400).send({
        error: 'confirm_required',
        message: 'Выключение HTTPS требует подтверждения.',
      });
    }
    localTls.disable();
    return { ok: true, status: await localTls.status(tlsRuntime) };
  });
}

export default fp(settingsModule, { name: 'module-settings' });
