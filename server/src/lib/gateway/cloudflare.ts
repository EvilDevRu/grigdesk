// Cloudflare API v4 — ровно для одной задачи: синхронизировать две A-записи шлюза.
//
// **Логином и паролем аккаунта API Cloudflare не управляется вовсе** (а при включённой 2FA —
// тем более). Нужен API-токен: кабинет → My Profile → API Tokens → Create Token → шаблон
// «Edit zone DNS» → Zone Resources: Include → Specific zone → нужный домен. Такой токен
// правит DNS ОДНОЙ зоны, поэтому его утечка стоит правки одного домена, а не всего аккаунта.
// Нужны ДВА разрешения на одну зону: Zone:Read — найти родительскую зону по имени, и
// DNS:Edit — прочитать и изменить записи. Шаблон «Edit zone DNS» даёт только второе,
// поэтому к нему надо вручную добавить Zone:Read.
//
// Токен нужен только на время каждой установки и никуда не сохраняется: живёт в памяти процесса.
// На VPS он не уезжает никогда — сертификаты Caddy продлевает сам по HTTP-01
// (см. docs/cockpit/gotchas.md, «Сертификаты — on-demand, а НЕ wildcard»).
//
// Записи ставятся СЕРЫМ облаком (`proxied: false`). Оранжевое — это Cloudflare-прокси,
// а с ним возвращаются ровно те ограничения, из-за которых был отвергнут Cloudflare Tunnel:
// 100-секундный потолок ответа (а `POST /api/chat` молчит весь ход агента), 100 МБ на тело
// (видео в распознавание) и чужая терминация TLS.

import { createHash } from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4';

// TTL 60 — минимум тарифа. Нужен не ради «свежести», а ради ПОВТОРА: ошибся адресом VPS,
// поправил — и проверка связи проходит через минуту, а не через час.
const RECORD_TTL = 60;

const FETCH_TIMEOUT_MS = 20_000;

// List DNS Records пагинирован. Даже фильтр по имени нельзя считать обещанием одной страницы:
// дубликатов у записи может быть сколько угодно, а именно их reconciliation и должен убрать.
const RECORDS_PER_PAGE = 100;
const RECORDS_MAX_PAGES = 100;
// Самый строгий лимит Cloudflare (Free). Один план не дробим: несколько batch потеряли бы
// свойство «всё либо ничего», ради которого этот endpoint и используется.
const BATCH_OPERATION_LIMIT = 200;

const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);
const BLOCKING_TYPES = new Set(['NS', 'DS', 'HTTPS', 'SVCB']);
const SANDBOX_LABEL_RE = /^p(51[7-9][0-9]|80[89][0-9])$/;

// DNS-запись зоны в том виде, в каком её отдаёт Cloudflare и читает план.
export interface DnsRecord extends Record<string, unknown> {
  id: string;
  type: string;
  name: string;
  content?: unknown;
  ttl?: unknown;
  proxied?: unknown;
  locked?: unknown;
}

// Запись, приведённая к безопасной форме: наружу уходит только это.
interface SafeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

// Желаемая A-запись шлюза.
interface DesiredRecord {
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

// Что план сделает с одним из двух имён шлюза.
interface PlannedName {
  name: string;
  action: 'created' | 'updated' | 'unchanged';
  id?: string;
  wasProxied: boolean;
}

// План приведения зоны к нужному виду. Ничего не меняет: одновременно предпросмотр
// человеку, тело batch-запроса и проверка постусловия после него.
export interface GatewayDnsPlan {
  domain: string;
  desired: PlannedName[];
  removed: SafeRecord[];
  preserved: SafeRecord[];
  batch: {
    deletes: Array<{ id: string }>;
    patches: Array<DesiredRecord & { id: string }>;
    posts: DesiredRecord[];
  };
}

// Зона Cloudflare в том минимуме, который нужен модулю.
export interface CloudflareZone {
  id: string;
  name: string;
}

type FetchImpl = typeof fetch;

/** Отказ Cloudflare с машинным кодом — чтобы визард показал человеку следующий шаг, а не JSON. */
export class CloudflareError extends Error {
  readonly code: string;

  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Один запрос к API. Возвращает полный envelope успешного ответа.
 *
 * Cloudflare отвечает 200 с `success: false` не всегда, но и такое бывает, поэтому решает
 * не код, а поле `success`. Коды ошибок именуем сами — текст Cloudflare английский и меняется.
 */
function redactSecret(value: unknown, secret: unknown): string {
  const text = String(value ?? '');
  const hidden = String(secret ?? '');

  if (!hidden || !text.includes(hidden)) return text;

  return text.split(hidden).join(`…${hidden.slice(-4)}`);
}

async function cfRequest(token: string, pathname: string, { method = 'GET', body, fetchImpl = fetch }: {
  method?: string;
  body?: unknown;
  fetchImpl?: FetchImpl;
} = {}): Promise<{ success?: boolean; result?: unknown; result_info?: { total_pages?: unknown } }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  let payload: {
    success?: boolean;
    result?: unknown;
    result_info?: { total_pages?: unknown };
    errors?: unknown;
  } | null;
  try {
    res = await fetchImpl(`${API}${pathname}`, {
      method,
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    payload = await res.json().catch(() => null) as typeof payload;
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name === 'AbortError') {
      throw new CloudflareError('cloudflare_unreachable', 'Cloudflare не ответил за 20 секунд.');
    }
    throw new CloudflareError(
      'cloudflare_unreachable',
      `Не достучались до Cloudflare: ${redactSecret((e as Error)?.message || e, token)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new CloudflareError(
      'cloudflare_forbidden',
      'Cloudflare отказал в доступе: токен неверен или у него нет прав на эту зону. '
        + 'Нужны две строки на родительскую зону: «Zone → Zone → Read» и '
        + '«Zone → DNS → Edit». Проверь среднюю колонку второй строки: '
        + '«Zone → Zone → Edit» выглядит похоже, но права на DNS не даёт.',
      { status: res.status },
    );
  }
  if (!payload || payload.success !== true) {
    const errors = Array.isArray(payload?.errors)
      ? (payload.errors as Array<{ code?: unknown; message?: unknown }>).map((error) => ({
        code: typeof error?.code === 'number' ? error.code : redactSecret(error?.code, token),
        message: redactSecret(error?.message, token),
      }))
      : [];
    const detail = redactSecret(
      errors.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`,
      token,
    );
    throw new CloudflareError('cloudflare_rejected', `Cloudflare отказал: ${detail}`, {
      status: res.status,
      errors,
    });
  }
  return payload;
}

async function cfFetch(
  token: string,
  pathname: string,
  options: Parameters<typeof cfRequest>[2] = {},
): Promise<unknown> {
  return (await cfRequest(token, pathname, options)).result;
}

/**
 * Кандидаты в имя зоны для `cockpit.example.com`: сам домен, затем `example.com`.
 *
 * Идём от длинного к короткому: поддомен, делегированный отдельной зоной, — обычное дело,
 * и его зона должна победить родительскую. Односложный хвост (`com`) зоной не бывает.
 */
export function zoneCandidates(domain: unknown): string[] {
  const parts = String(domain || '').trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 2 <= parts.length; i += 1) out.push(parts.slice(i).join('.'));
  return out;
}

/**
 * Найти зону по имени домена.
 *
 * Токен, ограниченный одной зоной, `GET /zones?name=` всё равно отдаёт — но только свою.
 * Поэтому «зоны не нашли» и «токен не от этого домена» для человека одно и то же, и текст
 * отказа называет обе причины сразу.
 */
export async function findZone(token: string, domain: string, { fetchImpl }: {
  fetchImpl?: FetchImpl;
} = {}): Promise<CloudflareZone> {
  const candidates = zoneCandidates(domain);
  if (!candidates.length) {
    throw new CloudflareError('bad_domain', `Не похоже на домен: «${domain}».`);
  }
  for (const name of candidates) {
    const list = await cfFetch(token, `/zones?name=${encodeURIComponent(name)}&status=active`, { fetchImpl }) as Array<{ id?: unknown; name?: unknown }> | null;
    if (!Array.isArray(list)) {
      throw new CloudflareError(
        'cloudflare_bad_response',
        'Cloudflare вернул список зон в неожиданном формате; менять DNS небезопасно.',
      );
    }
    if (list.length) {
      if (typeof list[0]?.id !== 'string' || typeof list[0]?.name !== 'string') {
        throw new CloudflareError(
          'cloudflare_bad_response',
          'Cloudflare вернул зону в неожиданном формате; менять DNS небезопасно.',
        );
      }
      if (normalizeRecordName(list[0].name) !== name) {
        throw new CloudflareError(
          'cloudflare_bad_response',
          'Cloudflare вернул не ту зону, которая была запрошена; менять DNS небезопасно.',
        );
      }
      return { id: String(list[0].id), name: String(list[0].name) };
    }
  }
  throw new CloudflareError(
    'zone_not_found',
    `Cloudflare не показал зону для «${domain}». Либо домен обслуживает не Cloudflare, `
      + 'либо токен выдан на другую зону (проверь в кабинете: Zone Resources → Specific zone).',
    { tried: candidates },
  );
}

/**
 * Полный листинг записей внутри выбранного namespace. `name.endswith` — лишь оптимизация
 * Cloudflare: каждой записи всё равно заново проверяем границу имени локально, чтобы ответ
 * провайдера или изменение семантики фильтра не расширили область удаления.
 */
export async function listGatewayDnsRecords(token: string, zoneId: string, domain: string, {
  fetchImpl,
}: { fetchImpl?: FetchImpl } = {}): Promise<DnsRecord[]> {
  const base = normalizeRecordName(domain);
  const records: DnsRecord[] = [];
  for (let page = 1; page <= RECORDS_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      'name.endswith': base,
      per_page: String(RECORDS_PER_PAGE),
      page: String(page),
    });
    const payload = await cfRequest(
      token,
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${params}`,
      { fetchImpl },
    );
    if (!Array.isArray(payload.result)) {
      throw new CloudflareError('cloudflare_bad_response', 'Cloudflare вернул DNS-записи в неожиданном формате.');
    }

    for (const record of payload.result as DnsRecord[]) {
      if (!record || typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.type !== 'string') {
        throw new CloudflareError('cloudflare_bad_response', 'Cloudflare вернул неполную DNS-запись; менять зону небезопасно.');
      }
      const name = normalizeRecordName(record.name);
      if (name === base || name.endsWith(`.${base}`)) records.push({ ...record, name });
    }

    const totalPages = Number(payload.result_info?.total_pages);
    if (Number.isInteger(totalPages) && totalPages > 0) {
      if (page >= totalPages) return records;
    } else if (payload.result.length < RECORDS_PER_PAGE) {
      return records;
    }
  }
  throw new CloudflareError(
    'cloudflare_too_many_records',
    `В области «${base}» больше ${RECORDS_PER_PAGE * RECORDS_MAX_PAGES} DNS-записей; `
      + 'автоматически менять такую область небезопасно.',
  );
}

function normalizeRecordName(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function sameARecord(record: DnsRecord, desired: DesiredRecord): boolean {
  return record.type === 'A'
    && record.content === desired.content
    && record.proxied === false
    && Number(record.ttl) === desired.ttl;
}

function keeperRank(record: DnsRecord, desired: DesiredRecord): number {
  if (sameARecord(record, desired)) return 0;
  if (record.content === desired.content) return 1;
  return 2;
}

function sandboxOwner(name: string, base: string): boolean {
  const suffix = `.${base}`;
  if (!name.endsWith(suffix)) return false;
  const label = name.slice(0, -suffix.length);
  return !label.includes('.') && SANDBOX_LABEL_RE.test(label);
}

function safeRecord(record: DnsRecord): SafeRecord {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: String(record.content ?? ''),
    ttl: Number(record.ttl) || 0,
    proxied: record.proxied === true,
  };
}

/**
 * Чистый план reconciliation. Он ничего не меняет и служит одновременно предпросмотром,
 * входом batch-запроса и проверкой постусловия после него.
 */
export function buildGatewayDnsPlan({ domain, ip, records = [] }: {
  domain?: unknown;
  ip?: string;
  records?: DnsRecord[];
} = {}): GatewayDnsPlan {
  const base = normalizeRecordName(domain);
  const names = [base, `*.${base}`];
  const owners = new Set(names);

  // Любая точная запись p<разрешённый-порт> сильнее wildcard — даже TXT. Но UI обещает
  // владение лишь двумя именами, поэтому дочернюю запись не удаляем молча, а останавливаемся.
  const shadowing = records.filter((record) => sandboxOwner(normalizeRecordName(record.name), base));
  if (shadowing.length) {
    const shown = shadowing.slice(0, 5).map((r) => `${r.type} ${r.name}`).join(', ');
    throw new CloudflareError(
      'cloudflare_wildcard_shadowed',
      `Точные записи стендов перекрывают *.${base}: ${shown}${shadowing.length > 5 ? '…' : ''}. `
        + 'Cockpit не удаляет дочерние имена без отдельного подтверждения; убери их в Cloudflare и повтори.',
      { records: shadowing.map(safeRecord) },
    );
  }

  const owned = records.filter((record) => owners.has(normalizeRecordName(record.name)));
  const blocker = owned.find((record) => {
    const type = String(record.type).toUpperCase();
    return BLOCKING_TYPES.has(type) || (ADDRESS_TYPES.has(type) && record.locked === true);
  });
  if (blocker) {
    throw new CloudflareError(
      'cloudflare_dns_blocked',
      `${blocker.type} ${blocker.name} нельзя безопасно заменить автоматически. `
        + 'Выбранные два имени должны быть выделены под шлюз Cockpit.',
      { record: safeRecord(blocker) },
    );
  }

  const deletes: SafeRecord[] = [];
  const patches: Array<DesiredRecord & { id: string }> = [];
  const posts: DesiredRecord[] = [];
  const desiredRecords: PlannedName[] = [];

  for (const name of names) {
    const desired: DesiredRecord = {
      type: 'A', name, content: String(ip ?? ''), ttl: RECORD_TTL, proxied: false,
    };
    const atName = owned.filter((record) => normalizeRecordName(record.name) === name);
    const address = atName.filter((record) => ADDRESS_TYPES.has(String(record.type).toUpperCase()));
    const aRecords = address.filter((record) => String(record.type).toUpperCase() === 'A')
      .sort((left, right) => keeperRank(left, desired) - keeperRank(right, desired)
        || left.id.localeCompare(right.id));
    const keeper = aRecords[0] || null;

    for (const record of address) {
      if (record !== keeper) deletes.push(safeRecord(record));
    }

    const wasProxied = address.some((record) => record.proxied === true);
    if (!keeper) {
      posts.push(desired);
      desiredRecords.push({ name, action: 'created', wasProxied });
    } else if (sameARecord(keeper, desired)) {
      desiredRecords.push({ name, action: 'unchanged', id: keeper.id, wasProxied });
    } else {
      patches.push({ id: keeper.id, ...desired });
      desiredRecords.push({ name, action: 'updated', id: keeper.id, wasProxied });
    }
  }

  const mutationCount = deletes.length + patches.length + posts.length;
  if (mutationCount > BATCH_OPERATION_LIMIT) {
    throw new CloudflareError(
      'cloudflare_batch_too_large',
      `Для синхронизации нужно ${mutationCount} изменений DNS, а безопасный атомарный лимит — `
        + `${BATCH_OPERATION_LIMIT}. Удали часть дублей вручную и повтори проверку.`,
      { mutationCount, limit: BATCH_OPERATION_LIMIT },
    );
  }

  // Порядок ответа List Records не гарантирован. Стабильный план нужен и batch, и отпечатку
  // подтверждения: одинаковая зона не должна выглядеть изменившейся лишь из-за перестановки.
  deletes.sort((left, right) => left.id.localeCompare(right.id));

  return {
    domain: base,
    desired: desiredRecords,
    removed: deletes,
    preserved: owned
      .filter((record) => !ADDRESS_TYPES.has(String(record.type).toUpperCase()))
      .map(safeRecord),
    batch: {
      deletes: deletes.map(({ id }) => ({ id })),
      patches,
      posts,
    },
  };
}

function planFingerprint(zone: CloudflareZone, plan: GatewayDnsPlan): string {
  return createHash('sha256').update(JSON.stringify({
    zoneId: zone.id,
    domain: plan.domain,
    batch: plan.batch,
  })).digest('hex');
}

function hasMutations(plan: GatewayDnsPlan): boolean {
  return plan.batch.deletes.length > 0 || plan.batch.patches.length > 0 || plan.batch.posts.length > 0;
}

/** Прочитать текущую зону и вернуть человеку точный план без мутаций. */
export async function inspectGatewayDns({ token, domain, ip, zoneId = '', fetchImpl }: {
  token?: string;
  domain?: unknown;
  ip?: string;
  zoneId?: string;
  fetchImpl?: FetchImpl;
} = {}): Promise<{ zone: CloudflareZone; plan: GatewayDnsPlan; fingerprint: string }> {
  const base = normalizeRecordName(domain);
  const zone = zoneId ? { id: zoneId, name: base } : await findZone(String(token), base, { fetchImpl });
  const existing = await listGatewayDnsRecords(String(token), zone.id, base, { fetchImpl });
  const plan = buildGatewayDnsPlan({ domain: base, ip, records: existing });
  return { zone, plan, fingerprint: planFingerprint(zone, plan) };
}

/**
 * Синхронизировать обе записи одним batch. Cloudflare применяет delete → patch → post
 * в одной DB-транзакции: CNAME успевает исчезнуть до создания A, а половины плана при отказе
 * не остаётся. Распространение по DNS-сети не атомарно — его отдельно ждёт installer.
 */
export async function ensureGatewayDns({
  token,
  domain,
  ip,
  zoneId = '',
  expectedFingerprint = '',
  fetchImpl,
}: {
  token?: string;
  domain?: unknown;
  ip?: string;
  zoneId?: string;
  expectedFingerprint?: string;
  fetchImpl?: FetchImpl;
} = {}) {
  const inspected = await inspectGatewayDns({ token, domain, ip, zoneId, fetchImpl });
  const { zone, plan, fingerprint } = inspected;

  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    throw new CloudflareError(
      'cloudflare_plan_changed',
      'DNS в Cloudflare изменился после предпросмотра. Cockpit ничего не менял: '
        + 'перечитай план и подтверди актуальные удаления заново.',
    );
  }

  if (hasMutations(plan)) {
    await cfFetch(String(token), `/zones/${encodeURIComponent(zone.id)}/dns_records/batch`, {
      method: 'POST',
      body: Object.fromEntries(Object.entries(plan.batch).filter(([, items]) => items.length)),
      fetchImpl,
    });

    // `success: true` подтверждает batch, но не наш invariant. Перечитываем API и требуем,
    // чтобы второй план оказался пустым — иначе к VPS и сертификатам переходить нельзя.
    const after = await listGatewayDnsRecords(String(token), zone.id, plan.domain, { fetchImpl });
    const postcondition = buildGatewayDnsPlan({ domain: plan.domain, ip, records: after });
    if (hasMutations(postcondition)) {
      throw new CloudflareError(
        'cloudflare_reconcile_failed',
        'Cloudflare принял изменения, но повторная проверка не увидела требуемое состояние DNS.',
      );
    }
  }

  return { zone, records: plan.desired, removed: plan.removed, preserved: plan.preserved };
}
