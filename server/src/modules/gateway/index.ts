// Поддержка внешнего шлюза (VPS с Caddy + обратные SSH-туннели).
//
// Единственная задача модуля — сказать Caddy, для каких имён можно выдавать сертификат.
//
// Зачем это нужно. Стенды живут на динамических поддоменах (`p5191.<домен>`), заранее их
// не перечислить, а блок `*.<домен>` в Caddy требует WILDCARD-сертификата — то есть DNS-01
// и постоянно лежащего на шлюзе токена от ВСЕЙ зоны. Поэтому идём другим путём:
// сертификаты «по требованию» (on-demand TLS, HTTP-01 на каждое имя), и никакого DNS-API
// на VPS нет вовсе. Токен провайдера нужен только кокпиту и только на время установки —
// сверить и синхронизировать две A-записи (`lib/gateway/cloudflare.js`).
//
// Caddy обязан спрашивать разрешение перед выдачей (иначе кто угодно направит своё имя на наш
// адрес и заставит выпускать сертификаты, пока не упрёмся в лимиты Let's Encrypt). Этот
// эндпоинт и есть такой вопрос: отвечает 200 «можно» либо 403 «нет».
//
// Публичный по необходимости — Caddy зовёт его до всякой авторизации. Данных не отдаёт,
// только «да/нет» по имени хоста.
//
// Вторая задача — УСТАНОВКА шлюза из интерфейса (`/api/gateway/setup/*`). Руками это два
// идемпотентных скрипта плюс две DNS-записи, которых ни один из них завести не может; визард
// закрывает ровно эту дыру, а скрипты только запускает. Эндпоинты закрыты общим гардом
// (публичен здесь ТОЛЬКО `tls-allow`): они ставят чужой ключ на чужой сервер и правят `.env`.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { createGatewayInstaller, GatewaySetupError, parseSetupInput } from '../../lib/gateway/installer.ts';
import type { GatewayInstallerConfig } from '../../lib/gateway/installer.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';

// Тело и строка запроса визарда — недоверенные: их проверяет `parseSetupInput`.
interface GatewayRoute {
  Querystring: { domain?: string };
  Body: Record<string, unknown>;
}

// Серверный config в объёме раздела. Полная форма — в config.ts.
type GatewayModuleConfig = GatewayInstallerConfig & {
  publicDomain?: string;
};

export interface GatewayModuleOptions {
  config: GatewayModuleConfig;
  prefs: PrefsStore;
}

/**
 * Разрешённые диапазоны портов стендов. Ограничение сознательное: без него шлюз стал бы
 * дверью к ЛЮБОМУ порту мозга — включая сам кокпит в обход входа, MySQL и ClickHouse.
 *   5170–5199 — фронты песочниц и слотов, 8080–8099 — их API.
 */
const SANDBOX_PORT_RE = /^(51[7-9][0-9]|80[89][0-9])$/;

/**
 * Можно ли выдавать сертификат для этого имени.
 *
 * Разрешаем ровно два вида: сам домен кокпита и `p<порт>.<домен>` с портом из диапазонов стендов.
 * Всё прочее — отказ.
 */
export function isAllowedGatewayHost(host: unknown, publicDomain: unknown): boolean {
  if (!host || !publicDomain) return false;
  // Регистр и завершающая точка в DNS не значимы, а вот пробелы — признак мусора.
  const h = String(host).trim().toLowerCase().replace(/\.$/, '');
  const base = String(publicDomain).trim().toLowerCase().replace(/\.$/, '');
  if (!h || !base) return false;

  if (h === base) return true;

  const suffix = `.${base}`;
  if (!h.endsWith(suffix)) return false;

  const label = h.slice(0, -suffix.length);
  // Ровно одна метка: `p5191`. Вложенные (`a.p5191`) не разрешаем.
  if (label.includes('.')) return false;
  const m = /^p(\d{2,5})$/.exec(label);
  return !!m && SANDBOX_PORT_RE.test(String(m[1]));
}

/** Отказ визарда человеку: машинный код + текст словами. Всё, что не наш класс, — 500. */
function replySetupError(fastify: FastifyInstance, reply: FastifyReply, thrown: unknown) {
  const e = thrown as { code?: string; message?: string } | null;

  if (thrown instanceof GatewaySetupError || e?.code) {
    const busy = e?.code === 'setup_busy';

    return reply.code(busy ? 409 : 400).send({ error: e?.code, message: e?.message });
  }
  fastify.log.error({ err: thrown }, 'Шлюз: установка сорвалась');

  return reply.code(500).send({ error: 'setup_failed', message: e?.message || String(thrown) });
}

async function gatewayModule(
  fastify: FastifyInstance,
  opts: GatewayModuleOptions,
): Promise<void> {
  const { config, prefs } = opts;

  // Прогресс уезжает во ВСЕ окна: установку начали с компьютера, а смотреть на неё могут
  // с планшета — как и всё остальное в кокпите. Событие одно на весь визард, тело — снимок.
  const installer = createGatewayInstaller({
    config,
    onEvent: (job) => { if (job) fastify.sse?.broadcast?.('gateway-setup', job); },
    log: fastify.log,
  });

  // Проба авторизации для `forward_auth` шлюза перед стендами.
  //
  // Отдельный эндпоинт, а НЕ `/api/auth/state`: тот отвечает 200 и невошедшему (в теле
  // `authenticated: false`), а `forward_auth` смотрит только на код — и пускал бы всех.
  // Здесь всё решает гард: без сессии сюда просто не доходит (401), с сессией — 204 без тела.
  fastify.get<GatewayRoute>('/api/gateway/authz', async (request, reply) => reply.code(204).send());

  // Caddy зовёт как `GET /api/gateway/tls-allow?domain=<host>`: 200 — выдавать, иначе отказ.
  fastify.get<GatewayRoute>('/api/gateway/tls-allow', async (request, reply) => {
    const domain = request.query?.domain || '';
    if (!config.publicDomain) {
      // Шлюз не настроен — сертификаты по требованию выдавать незачем.
      return reply.code(403).send('gateway disabled');
    }
    if (!isAllowedGatewayHost(domain, config.publicDomain)) {
      fastify.log.warn({ domain }, 'Шлюз: отказ в сертификате для неразрешённого имени');
      return reply.code(403).send('not allowed');
    }
    return reply.send('ok');
  });

  /* ───────────────────────────── установка шлюза из интерфейса ───────────────────────────── */

  // Что показать в разделе при открытии: слепок прошлой установки, состояние идущей и то,
  // подхватил ли процесс домен (`publicDomain` читается ОДИН раз при старте — пока не
  // перезапустили, on-demand TLS и домен cookie ещё не работают, и это надо назвать).
  fastify.get<GatewayRoute>('/api/gateway/setup', async () => ({
    setup: await installer.readSetup(),
    job: installer.status(),
    busy: installer.busy,
    publicDomain: config.publicDomain || '',
  }));

  // Проба ДО пароля: жив ли сервер и с каким отпечатком ключа.
  //
  // Отдельным шагом, потому что доверять хосту «по первому подключению» и сразу слать ему
  // пароль root — это отдать чужому посередине и то, и другое. Человек сверяет отпечаток
  // с тем, что показала панель провайдера, и только потом вводит пароль.
  fastify.post<GatewayRoute>('/api/gateway/setup/probe', async (request, reply) => {
    try {
      return await installer.probe({
        gateway: request.body?.gateway,
        sshPort: Number(request.body?.sshPort || 22),
        sshUser: String(request.body?.sshUser || 'root'),
      });
    } catch (e) {
      return replySetupError(fastify, reply, e);
    }
  });

  // Read-only сверка Cloudflare перед опасным подтверждением. Токен используется только
  // в этом запросе и не попадает ни в job, ни в setup.json; перед самой установкой план
  // строится заново, поэтому изменение зоны между модалкой и кликом не пройдёт незамеченным.
  fastify.post<GatewayRoute>('/api/gateway/setup/dns-plan', async (request, reply) => {
    try {
      const input = parseSetupInput(request.body || {});
      return await installer.inspectDns(input);
    } catch (e) {
      return replySetupError(fastify, reply, e);
    }
  });

  // Запуск. Отвечаем СРАЗУ (202), не дожидаясь конца: bootstrap VPS ставит пакеты, а ожидание
  // DNS занимает до пяти минут — держать столько HTTP-запрос нельзя, окно оборвётся и человек
  // решит, что установка провалилась. Дальше всё видно по SSE `gateway-setup`.
  fastify.post<GatewayRoute>('/api/gateway/setup/start', async (request, reply) => {
    let input: ReturnType<typeof parseSetupInput>;
    try {
      input = parseSetupInput(request.body || {}, { requireCloudflarePlan: true });
    } catch (e) {
      return replySetupError(fastify, reply, e);
    }
    if (installer.busy) {
      return reply.code(409).send({ error: 'setup_busy', message: 'Установка уже идёт.' });
    }

    installer.run(input).then((job) => {
      // Старый UI раскрывал визард по этому prefs-маркеру. Сохраняем совместимость снимка,
      // но runtime шлюза этим флагом не управляется: факт настройки UI берёт из setup/job.
      if (job?.state === 'done' && prefs?.read().accessGateway !== true) {
        try {
          prefs.write({ accessGateway: true });
        } catch (e) {
          fastify.log.warn({ err: e }, 'Шлюз: не смогли включить режим доступа в настройках');
        }
      }
    }).catch((e) => fastify.log.error({ err: e }, 'Шлюз: установка сорвалась'));

    return reply.code(202).send({ job: installer.status() });
  });

  // Состояние идущей установки. Нужен помимо SSE: событие доставляется один раз, а окно могли
  // открыть позже, перезагрузить или потерять связь.
  fastify.get<GatewayRoute>('/api/gateway/setup/status', async () => ({
    job: installer.status(),
    busy: installer.busy,
  }));

  // Проверка связи отдельной кнопкой. Она же — единственный способ проверить после ручного
  // шага и после перезапуска сервера: до него `COCKPIT_PUBLIC_DOMAIN` в конфиг не попал,
  // и проверка стенда честно пропускается.
  fastify.post<GatewayRoute>('/api/gateway/setup/verify', async (request, reply) => {
    const saved = await installer.readSetup();
    const src = { ...(saved || {}), ...(request.body || {}) } as Record<string, unknown>;
    if (!src.domain || !src.gateway) {
      return reply.code(400).send({ error: 'no_setup', message: 'Шлюз ещё не настраивался — нечего проверять.' });
    }
    try {
      return await installer.verify({
        domain: String(src.domain),
        gateway: String(src.gateway),
        sshPort: Number(src.sshPort || 22),
        sshUser: String(src.sshUser || 'root'),
      });
    } catch (e) {
      return replySetupError(fastify, reply, e);
    }
  });
}

export default fp(gatewayModule, { name: 'module-gateway' });
