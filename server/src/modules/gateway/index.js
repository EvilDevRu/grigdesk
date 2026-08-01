// Поддержка внешнего шлюза (VPS с Caddy + обратные SSH-туннели).
//
// Единственная задача модуля — сказать Caddy, для каких имён можно выдавать сертификат.
//
// Зачем это нужно. Стенды живут на динамических поддоменах (`p5191.<домен>`), заранее их
// не перечислить, а блок `*.<домен>` в Caddy требует WILDCARD-сертификата — то есть DNS-01
// и API DNS-провайдера. У нас зона на Yandex, плагина может не быть, поэтому идём другим путём:
// сертификаты «по требованию» (on-demand TLS, HTTP-01 на каждое имя).
//
// Caddy обязан спрашивать разрешение перед выдачей (иначе кто угодно направит своё имя на наш
// адрес и заставит выпускать сертификаты, пока не упрёмся в лимиты Let's Encrypt). Этот
// эндпоинт и есть такой вопрос: отвечает 200 «можно» либо 403 «нет».
//
// Публичный по необходимости — Caddy зовёт его до всякой авторизации. Данных не отдаёт,
// только «да/нет» по имени хоста.
import fp from 'fastify-plugin';

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
export function isAllowedGatewayHost(host, publicDomain) {
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
  return !!m && SANDBOX_PORT_RE.test(m[1]);
}

async function gatewayModule(fastify, opts) {
  const { config } = opts;

  // Проба авторизации для `forward_auth` шлюза перед стендами.
  //
  // Отдельный эндпоинт, а НЕ `/api/auth/state`: тот отвечает 200 и невошедшему (в теле
  // `authenticated: false`), а `forward_auth` смотрит только на код — и пускал бы всех.
  // Здесь всё решает гард: без сессии сюда просто не доходит (401), с сессией — 204 без тела.
  fastify.get('/api/gateway/authz', async (request, reply) => reply.code(204).send());

  // Caddy зовёт как `GET /api/gateway/tls-allow?domain=<host>`: 200 — выдавать, иначе отказ.
  fastify.get('/api/gateway/tls-allow', async (request, reply) => {
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
}

export default fp(gatewayModule, { name: 'module-gateway' });
