// Исполнитель Claude (Anthropic, Claude Code CLI).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCatalog, claudeOauthMetadata } from './_claude-catalog.js';
import { npmLatest } from './_npm-latest.js';
import { createStepSink } from '../chat/stream-steps.js';
import { toClaudeSteps } from './_claude-steps.js';

/**
 * probe/efforts гоняют CLI — короткие таймауты, ошибки не роняют реестр.
 * anyExit: вернуть вывод даже при ненулевом коде — так читается текст ошибки
 * валидации (в нём CLI перечисляет допустимые значения флага).
 */
function exec(bin, args, { timeout = 15_000, anyExit = false } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout || '');
      resolve(anyExit ? `${stdout || ''}\n${stderr || ''}` : null);
    });
  });
}

export function parseClaudeEfforts(help) {
  const block = String(help || '').match(
    /^[ \t]*--effort\b[^\r\n]*(?:\r?\n(?![ \t]*--)[ \t]+[^\r\n]*){0,3}/mi,
  )?.[0];
  const choices = block?.match(/\(([^)\r\n]+)\)/)?.[1];
  if (!choices) return null;

  const levels = choices
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^[a-z][a-z0-9_-]*$/i.test(value));
  return levels.length ? levels : null;
}

// Подписи режимов прав для UI. Список режимов приходит из CLI (modes()), а человеческие
// названия и пояснения — здесь: CLI их не отдаёт. Незнакомый режим покажется как есть.
// order — порядок в селекте: от самого осторожного к самому свободному, план — первым
// (это отдельный сценарий «сначала подумай»), а не по алфавиту, как отдаёт CLI.
const MODE_LABELS = {
  plan: { order: 1, label: 'План', hint: 'Только изучает код и предлагает план, ничего не меняет' },
  manual: { order: 2, label: 'Вручную', hint: 'Спрашивать разрешение на каждое действие' },
  auto: { order: 3, label: 'Авто', hint: 'Безопасные действия делает сам, на рискованных спросит' },
  acceptEdits: { order: 4, label: 'Правки без спроса', hint: 'Файлы правит молча, остальное спрашивает' },
  dontAsk: { order: 5, label: 'Не спрашивать', hint: 'Действует без подтверждений' },
  bypassPermissions: { order: 6, label: 'Без ограничений', hint: 'Обходит все проверки прав — на свой страх' },
};

// Сообщения, которые CLI сочиняет САМ, без обращения к API («API Error: 529 Overloaded»,
// «Connection closed mid-response», «No response requested.», отвал авторизации), приезжают
// в поток обычным assistant-ходом — с этим model и НУЛЕВЫМ usage. Ходом модели их считать
// нельзя: в шапке чата вместо модели загоралось «факт: <synthetic>», а нулевой usage
// обнулял входные токены хода — и размер контекста откатывался на сумму по ВСЕМ ходам,
// кратно завышая кольцо. Отличать по ev.isApiErrorMessage нельзя: у «No response
// requested.» он false.
const SYNTHETIC_MODEL = '<synthetic>';

// ── Лимиты подписки и доплата сверх них (в CLI это `/usage` и `/usage-credits`) ──
// Ручки приватные, OAuth-подписочные: работают только с токеном хостового CLI
// (~/.claude/.credentials.json), API-ключ тут не годится. Контракт снят с бинаря
// установленного CLI — Anthropic его не документирует, поэтому ошибки НЕ глотаем:
// поменяют ручку — человек должен увидеть, что именно отвалилось.
const API = 'https://api.anthropic.com';
const OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;
// Дефолтный месячный потолок при первом включении доплаты — как у CLI (2000 = 20.00).
const DEFAULT_LIMIT_MINOR = 2000;

function defaultCredentialsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

async function readCliCredentials(credentialsPath) {
  try {
    return JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  } catch {
    return null;
  }
}

function tokenNeedsRefresh(oauth, now) {
  if (!oauth?.accessToken) return true;
  const expiresAt = Number(oauth.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now + OAUTH_REFRESH_SKEW_MS;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claude Code вращает refresh token и защищает это общей директорией-lock.
 * Используем тот же lock, иначе одновременный ход CLI и фоновая проверка Cockpit
 * могут оба обновить один refresh token и затереть рабочие credentials.
 */
async function acquireOauthRefreshLock(credentialsPath, sleep = wait) {
  const lockPath = path.join(path.dirname(credentialsPath), '.oauth_refresh.lock');
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      return async () => {
        try { await fs.rmdir(lockPath); } catch { /* lock уже снят */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await sleep(250);
    }
  }
  return null;
}

async function writeCliCredentials(credentialsPath, credentials) {
  const tmp = path.join(
    path.dirname(credentialsPath),
    `.${path.basename(credentialsPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, credentialsPath);
  } finally {
    try { await fs.unlink(tmp); } catch { /* rename уже убрал временный файл */ }
  }
}

function refreshFailure({ hasCredentials = true, refreshable = true, error, invalid = false }) {
  return { token: null, hasCredentials, refreshable, error, invalid };
}

async function oauthRefreshConfig(oauth, {
  claudeBin,
  oauthClientId,
  oauthTokenUrl,
}) {
  if (oauthClientId || oauthTokenUrl) {
    return oauthClientId && oauthTokenUrl
      ? { clientId: oauthClientId, tokenUrl: oauthTokenUrl }
      : { error: 'oauth_refresh_config_incomplete' };
  }
  if (oauth?.clientId || oauth?.tokenUrl) {
    return oauth.clientId && oauth.tokenUrl
      ? { clientId: oauth.clientId, tokenUrl: oauth.tokenUrl }
      : { error: 'oauth_refresh_credentials_metadata_incomplete' };
  }
  const detected = await claudeOauthMetadata({ claudeBin }).catch(() => null);
  return detected || { error: 'oauth_refresh_metadata_missing' };
}

/**
 * Возвращает актуальный OAuth access token хостового Claude CLI.
 * Access token короткоживущий; наличие истёкшего access token при живом refresh token
 * означает нормальную авторизованную сессию, а не повод отправлять человека в login.
 */
export async function resolveClaudeCliToken({
  credentialsPath = defaultCredentialsPath(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = wait,
  forceRefresh = false,
  failedAccessToken = null,
  claudeBin = 'claude',
  oauthClientId = '',
  oauthTokenUrl = '',
} = {}) {
  let credentials = await readCliCredentials(credentialsPath);
  let oauth = credentials?.claudeAiOauth;
  const hasCredentials = !!(oauth?.accessToken || oauth?.refreshToken);
  if (!hasCredentials) {
    return refreshFailure({
      hasCredentials: false,
      refreshable: false,
      error: 'missing_credentials',
    });
  }
  if (failedAccessToken && oauth.accessToken && oauth.accessToken !== failedAccessToken) {
    return {
      token: oauth.accessToken,
      hasCredentials: true,
      refreshable: !!oauth.refreshToken,
      error: '',
      invalid: false,
    };
  }
  if (!forceRefresh && !tokenNeedsRefresh(oauth, now())) {
    return {
      token: oauth.accessToken,
      hasCredentials: true,
      refreshable: !!oauth.refreshToken,
      error: '',
      invalid: false,
    };
  }
  if (!oauth.refreshToken) {
    return {
      token: oauth.accessToken || null,
      hasCredentials: true,
      refreshable: false,
      error: 'missing_refresh_token',
      invalid: false,
    };
  }

  const refreshConfig = await oauthRefreshConfig(oauth, {
    claudeBin,
    oauthClientId,
    oauthTokenUrl,
  });
  if (refreshConfig.error) return refreshFailure({ error: refreshConfig.error });

  let release;
  try {
    release = await acquireOauthRefreshLock(credentialsPath, sleep);
  } catch (error) {
    return refreshFailure({
      error: `oauth_refresh_lock_${String(error?.code || 'failed').toLowerCase()}`,
    });
  }
  if (!release) {
    credentials = await readCliCredentials(credentialsPath);
    oauth = credentials?.claudeAiOauth;
    if (oauth?.accessToken && oauth.accessToken !== failedAccessToken && !tokenNeedsRefresh(oauth, now())) {
      return {
        token: oauth.accessToken,
        hasCredentials: true,
        refreshable: !!oauth.refreshToken,
        error: '',
        invalid: false,
      };
    }
    return refreshFailure({ error: 'oauth_refresh_busy' });
  }

  try {
    // Пока ждали lock, сам CLI мог уже обновить и повернуть токены.
    credentials = await readCliCredentials(credentialsPath);
    oauth = credentials?.claudeAiOauth;
    const observedAccessToken = failedAccessToken || oauth?.accessToken;
    if (!oauth?.refreshToken) {
      return refreshFailure({
        hasCredentials: !!oauth?.accessToken,
        refreshable: false,
        error: 'missing_refresh_token',
      });
    }
    if (
      oauth.accessToken
      && (
        (failedAccessToken && oauth.accessToken !== failedAccessToken)
        || (!forceRefresh && !tokenNeedsRefresh(oauth, now()))
      )
    ) {
      return {
        token: oauth.accessToken,
        hasCredentials: true,
        refreshable: true,
        error: '',
        invalid: false,
      };
    }

    const refreshToken = oauth.refreshToken;
    const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter(Boolean) : [];
    let response;
    try {
      const body = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: refreshConfig.clientId,
      };
      if (scopes.length) body.scope = scopes.join(' ');
      response = await fetchImpl(refreshConfig.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return refreshFailure({ error: error?.message || 'oauth_refresh_network_error' });
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const code = String(data?.error || '');
      const invalid = response.status === 401
        || ['invalid_grant', 'invalid_refresh_token', 'expired_refresh_token'].includes(code);
      return refreshFailure({
        error: code ? `oauth_refresh_${code}` : `oauth_refresh_http_${response.status}`,
        invalid,
      });
    }

    const expiresIn = Number(data?.expires_in);
    if (!data?.access_token || !(expiresIn > 0)) {
      return refreshFailure({ error: 'oauth_refresh_invalid_response' });
    }

    // CAS поверх файла: процесс, который не знает о нашем lock, мог успеть повернуть
    // refresh token. Его более свежую пару в этом случае не перезаписываем.
    const latest = await readCliCredentials(credentialsPath);
    const latestOauth = latest?.claudeAiOauth;
    if (latestOauth?.refreshToken !== refreshToken) {
      if (latestOauth?.accessToken && latestOauth.accessToken !== observedAccessToken) {
        return {
          token: latestOauth.accessToken,
          hasCredentials: true,
          refreshable: !!latestOauth.refreshToken,
          error: '',
          invalid: false,
        };
      }
      return refreshFailure({ error: 'oauth_refresh_raced' });
    }

    const refreshedAt = now();
    const returnedScopes = typeof data.scope === 'string'
      ? data.scope.split(/\s+/).filter(Boolean)
      : scopes;
    const refreshExpiresIn = Number(data.refresh_token_expires_in);
    const nextOauth = {
      ...latestOauth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: refreshedAt + expiresIn * 1000,
      scopes: returnedScopes,
      ...(refreshExpiresIn > 0
        ? { refreshTokenExpiresAt: refreshedAt + refreshExpiresIn * 1000 }
        : {}),
    };
    await writeCliCredentials(credentialsPath, {
      ...latest,
      claudeAiOauth: nextOauth,
    });
    return {
      token: nextOauth.accessToken,
      hasCredentials: true,
      refreshable: true,
      error: '',
      invalid: false,
    };
  } finally {
    await release();
  }
}

async function cliToken(options) {
  return (await resolveClaudeCliToken(options)).token;
}

function authHeaders(tok) {
  return {
    Authorization: `Bearer ${tok}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  };
}

/**
 * Сырой ответ ручки потребления. Сеть до api.anthropic.com бывает нестабильна (VPN) —
 * пробуем дважды.
 */
async function requestUsage(tok, fetchImpl) {
  let r = null;
  let error = null;
  for (let i = 0; i < 2; i++) {
    try {
      r = await fetchImpl(`${API}/api/oauth/usage`, {
        headers: authHeaders(tok),
        signal: AbortSignal.timeout(10_000),
      });
      // Повтор безопасен только для сетевых/серверных сбоев. 401/403/429 —
      // самостоятельные состояния интерфейса, повтор их лишь задержит.
      if (r.status < 500) break;
    } catch (e) {
      error = e;
      r = null;
    }
  }
  return { response: r, error: error?.message || '' };
}

async function usageResponse(result) {
  const r = result.response;
  if (!r) return { hasToken: true, status: 0, error: result.error || 'network_error' };
  const text = await r.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text ? { message: text.slice(0, 500) } : null; }
  return {
    hasToken: true,
    status: r.status,
    data,
    retryAfter: r.headers.get('retry-after'),
  };
}

export async function fetchClaudeUsage({
  credentialsPath = defaultCredentialsPath(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = wait,
  claudeBin = 'claude',
  oauthClientId = '',
  oauthTokenUrl = '',
} = {}) {
  const tokenOpts = {
    credentialsPath,
    fetchImpl,
    now,
    sleep,
    claudeBin,
    oauthClientId,
    oauthTokenUrl,
  };
  const auth = await resolveClaudeCliToken(tokenOpts);
  if (!auth.token) {
    if (!auth.hasCredentials) return { hasToken: false };
    return {
      hasToken: true,
      status: auth.invalid ? 401 : 0,
      error: auth.error,
    };
  }

  let result = await requestUsage(auth.token, fetchImpl);
  if (result.response?.status === 401 && auth.refreshable) {
    const refreshed = await resolveClaudeCliToken({
      ...tokenOpts,
      forceRefresh: true,
      failedAccessToken: auth.token,
    });
    if (refreshed.token && refreshed.token !== auth.token) {
      result = await requestUsage(refreshed.token, fetchImpl);
    } else if (!refreshed.invalid) {
      // Живая OAuth-сессия, которую сейчас не удалось обновить, — временный сбой,
      // а не команда человеку повторно логиниться.
      return {
        hasToken: true,
        status: 0,
        error: refreshed.error || 'oauth_refresh_failed',
      };
    }
  }
  return usageResponse(result);
}

/**
 * Доплата сверх лимитов в человеческом виде. Суммы у Anthropic — в минорных единицах
 * (центах), наружу отдаём в валюте счёта; `minor` оставляем, чтобы обратно умножить
 * ровно на то же, а не гадать про валюты с другим числом знаков.
 */
function creditsOf(d) {
  const x = d?.extra_usage;
  if (!x) return null;
  const minor = 10 ** (x.decimal_places ?? 2);
  const num = (v) => (typeof v === 'number' ? v / minor : null);
  return {
    enabled: !!x.is_enabled,
    limit: num(x.monthly_limit),
    used: num(x.used_credits),
    utilization: typeof x.utilization === 'number' ? x.utilization : null,
    currency: x.currency || '',
    minor,
    // Включено, но потолка нет — тратится без ограничения сверху.
    unlimited: !!x.is_enabled && x.monthly_limit === null,
    disabledReason: x.disabled_reason || null,
  };
}

// Суммы в подписи: целые — без копеек, дробные — с двумя знаками.
const money = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function creditsNote(c) {
  if (!c.enabled) return 'выключено';
  if (c.unlimited) return 'без месячного потолка';
  if (c.limit == null || c.used == null) return '';
  return `${money(c.used)} из ${money(c.limit)} ${c.currency}`.trim();
}

export function parseClaudeUsagePayload(d) {
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  const bars = [];
  const KIND = { session: 'Сессия (5ч)', weekly_all: 'Неделя (7д)' };

  for (const l of d?.limits || []) {
    if (typeof l.percent !== 'number') continue;
    let label = KIND[l.kind] || String(l.kind || '').replace(/_/g, ' ');
    if (l.kind === 'weekly_scoped') {
      label = `Неделя · ${l.scope?.model?.display_name || l.scope?.surface || '?'}`;
    }
    bars.push({
      key: l.kind + (l.scope?.model?.display_name || ''),
      label,
      pct: clamp(l.percent),
      resetsAt: l.resets_at || null,
    });
  }

  if (!bars.length) {
    for (const [key, value] of Object.entries(d || {})) {
      if (!value || typeof value !== 'object' || typeof value.utilization !== 'number') continue;
      bars.push({
        key,
        label: key.replace(/_/g, ' '),
        pct: clamp(value.utilization),
        resetsAt: value.resets_at || null,
      });
    }
  }
  return bars;
}

/**
 * Account-level usage resources are separate from quota meters. Controls are
 * declarative: the web UI renders them generically, while the executor owns
 * action ids, confirmation copy and the actual vendor calls.
 */
export function parseClaudeUsageResources(d) {
  const c = creditsOf(d);
  if (!c) return [];
  const cur = c.currency || 'в валюте счёта';
  return [{
    key: 'extra-usage',
    label: 'Extra usage (доплата)',
    summary: creditsNote(c),
    tone: c.enabled ? 'ok' : 'muted',
    ...(c.enabled && c.utilization !== null
      && { percent: Math.max(0, Math.min(100, Math.round(c.utilization))) }),
    note: c.unlimited
      ? 'Потолка нет — расходы не ограничены сверху.'
      : (c.disabledReason ? `Причина отказа: ${c.disabledReason}` : ''),
    controls: [
      {
        id: 'extra-usage-toggle',
        kind: 'toggle',
        label: c.enabled ? 'доплата включена' : 'доплата выключена',
        value: c.enabled,
        action: 'configure-extra-usage',
        field: 'enabled',
        confirm: {
          on: {
            text: `Кончатся лимиты подписки — работа продолжится за деньги с карты аккаунта Anthropic. Месячный потолок ${c.limit ? `${c.limit} ${cur}` : `20 ${cur}`}.`,
            label: 'Включить',
          },
          off: {
            text: 'Списаний больше не будет: кончатся лимиты подписки — агенты встанут до сброса.',
            label: 'Выключить',
            danger: true,
          },
        },
      },
      ...(c.enabled ? [{
        id: 'extra-usage-limit',
        kind: 'number',
        label: 'потолок',
        value: c.limit,
        unit: c.currency,
        minExclusive: 0,
        action: 'configure-extra-usage',
        field: 'limit',
        confirm: {
          text: 'Доплата будет останавливаться на {value} {unit} в месяц.',
          label: 'Поставить',
        },
      }] : []),
      {
        id: 'manage-extra-usage',
        kind: 'link',
        label: 'Карта, история и доплата без потолка — на claude.ai',
        href: 'https://claude.ai/settings/usage',
      },
    ],
  }];
}

function usageErrorMessage(data) {
  return data?.error?.message || data?.message || '';
}

function retryAtOf(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

export function classifyClaudeUsageResponse({
  hasToken,
  status = 0,
  data = null,
  error = '',
  retryAfter = null,
  now = Date.now(),
} = {}) {
  const login = { kind: 'terminal', label: 'Войти в Claude', command: 'claude login' };
  if (!hasToken) {
    return {
      state: 'auth_required',
      bars: [],
      message: 'Claude CLI не авторизован. Выполни claude login.',
      action: login,
    };
  }
  if (status === 200) {
    const bars = parseClaudeUsagePayload(data);
    const resources = parseClaudeUsageResources(data);
    if (!bars.length && !resources.length) {
      return {
        state: 'unavailable',
        bars: [],
        resources: [],
        message: 'Anthropic не вернул данные о лимитах Claude.',
        action: null,
      };
    }
    return { state: 'ok', bars, resources, message: '', action: null };
  }
  if (status === 401) {
    return {
      state: 'auth_required',
      bars: [],
      message: 'Авторизация Claude истекла или недействительна. Войди заново.',
      detail: usageErrorMessage(data),
      action: login,
    };
  }
  if (status === 403) {
    return {
      state: 'blocked',
      bars: [],
      message: 'Anthropic отклонил запрос аккаунта. Проверь доступ к Claude и состояние подписки.',
      detail: usageErrorMessage(data),
      action: null,
    };
  }
  if (status === 429) {
    return {
      state: 'rate_limited',
      bars: [],
      message: 'Anthropic временно ограничил запрос проверки лимитов.',
      detail: usageErrorMessage(data),
      retryAt: retryAtOf(retryAfter, now),
      action: null,
    };
  }
  return {
    state: 'unavailable',
    bars: [],
    message: 'Не удалось получить лимиты Claude. Повторим проверку автоматически.',
    detail: usageErrorMessage(data) || error,
    action: null,
  };
}

/**
 * UUID организации: CLI кладёт его в ~/.claude.json при логине. Файла/поля нет —
 * спрашиваем профиль тем же токеном.
 */
async function orgUuid(tok) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (j?.oauthAccount?.organizationUuid) return j.oauthAccount.organizationUuid;
  } catch { /* файла нет или он битый — спросим у API */ }
  const r = await fetch(`${API}/api/oauth/profile`, {
    headers: authHeaders(tok),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const d = await r.json().catch(() => null);
  return d?.organization?.uuid || d?.organization?.organization_uuid || d?.account?.organization_uuid || null;
}

/**
 * Вызов организационной ручки: uuid идёт и в путь, и в заголовок (так же делает CLI).
 * Ошибку разворачиваем в текст для человека — у этих ручек он осмысленный
 * («no payment method on file» и т.п.).
 */
async function orgCall(tok, org, method, sub, body) {
  const r = await fetch(`${API}/api/oauth/organizations/${org}${sub}`, {
    method,
    headers: { ...authHeaders(tok), 'x-organization-uuid': org, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => { throw new Error(`сеть недоступна: ${e.message}`); });
  if (r.ok) return r.json().catch(() => ({}));
  const text = await r.text().catch(() => '');
  let msg = '';
  try { msg = JSON.parse(text)?.error?.message || ''; } catch { /* не JSON — покажем как есть */ }
  throw new Error(`${r.status} ${msg || text.slice(0, 300) || r.statusText}`.trim());
}

/**
 * Configure Claude overage. Kept outside the executor object so the provider
 * action map remains a thin, explicit allow-list rather than a generic RPC.
 */
async function configureClaudeExtraUsage(patch = {}, config = {}) {
  const tokenOpts = {
    claudeBin: config.claudeBin,
    oauthClientId: config.claudeOauthClientId,
    oauthTokenUrl: config.claudeOauthTokenUrl,
  };
  const tok = await cliToken(tokenOpts);
  if (!tok) return { ok: false, error: 'Нет токена хостового CLI — авторизуйся на хосте: claude login' };

  const before = await fetchClaudeUsage(tokenOpts);
  const state = creditsOf(before.status === 200 ? before.data : null);
  if (!state) return { ok: false, error: 'Anthropic не отдал состояние доплаты — попробуй позже' };

  const wantEnabled = patch.enabled === undefined ? state.enabled : !!patch.enabled;
  const limit = patch.limit;
  if (limit !== undefined && !(typeof limit === 'number' && limit > 0)) {
    return { ok: false, error: 'Месячный потолок — положительное число' };
  }
  if (limit !== undefined && !wantEnabled) {
    return { ok: false, error: 'Сначала включи доплату — потом меняй потолок' };
  }
  const minor = limit === undefined ? null : Math.round(limit * state.minor);

  const org = await orgUuid(tok);
  if (!org) return { ok: false, error: 'Не удалось определить организацию аккаунта' };

  try {
    if (!wantEnabled) {
      await orgCall(tok, org, 'PUT', '/overage_spend_limit', { is_enabled: false });
    } else {
      if (!state.enabled) {
        await orgCall(tok, org, 'POST', '/setup_overage_billing', {
          org_monthly_spend_limit: minor ?? DEFAULT_LIMIT_MINOR,
        }).catch(() => null);
      }
      const body = { is_enabled: true };
      if (minor !== null) {
        body.monthly_credit_limit = minor;
        if (state.currency) body.currency = state.currency;
      }
      await orgCall(tok, org, 'PUT', '/overage_spend_limit', body);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const after = await fetchClaudeUsage(tokenOpts);
  return { ok: true, resource: parseClaudeUsageResources(after.status === 200 ? after.data : null)[0] || null };
}

/** Аргументы CLI для настроек, которыми управляет Cockpit. */
export function claudeProviderSettingsArgs(settings = {}) {
  return ['--settings', JSON.stringify({ fastMode: settings.fastMode === true })];
}

// Слэш-команды Claude для меню чата. Print-режим (`-p --resume`) перехватывает их сам:
// состав проверен гейтом исполняемости (2026-08-06, claude 2.1.220). /status, /vim и
// прочие TUI-only отвечают «isn't available in this environment» — не берём; /clear
// ОПАСЕН (молча начинает НОВУЮ сессию с пустым stdout → ложный emptyRun) — не берём.
// /compact — боевой путь кнопки сжатия; в меню скрыт дедупликацией (кокпит сильнее).
const CLAUDE_BUILTIN_COMMANDS = [
  { cmd: '/cost', desc: 'Стоимость и длительность сессии', run: 'prompt' },
  { cmd: '/usage', desc: 'Расход токенов сессии', run: 'prompt' },
  { cmd: '/context', desc: 'Оценка заполнения контекста', run: 'prompt' },
  { cmd: '/model', desc: 'Текущая модель CLI и доступные алиасы', run: 'prompt' },
  { cmd: '/compact', desc: 'Сжать контекст разговора', run: 'prompt' },
];

// Описание пользовательской команды: frontmatter `description` или первая непустая
// строка markdown-тела. Обрезается до 120 символов (контракт меню).
function claudeCommandDesc(text) {
  const fallback = 'Пользовательская команда';
  const source = String(text || '');
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fm) {
    const line = fm[1].split(/\r?\n/).find((l) => /^description\s*:/.test(l));
    if (line) {
      const desc = line.replace(/^description\s*:\s*/, '').replace(/^["']|["']$/g, '').trim();
      if (desc) return desc.slice(0, 120);
    }
  }
  const body = fm ? source.slice(fm[0].length) : source;
  const first = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return (first || fallback).slice(0, 120);
}

/**
 * Пользовательские команды уровня машины: $CLAUDE_CONFIG_DIR/commands/*.md
 * (по умолчанию ~/.claude/commands). Имя файла = имя команды. В print-режиме CLI
 * расширяет шаблон и шлёт модели (проверено гейтом) — все они run: 'prompt'.
 * Каталога может не быть, файл может не прочитаться — пропускаем, реестр не валится.
 * Проектный уровень (<cwd>/.claude/commands) намеренно не сканируется: глобальный кэш
 * /api/providers не знает cwd конкретного чата (план §6).
 */
async function scanClaudeUserCommands() {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'commands');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const commands = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try {
      const text = await fs.readFile(path.join(dir, entry.name), 'utf8');
      commands.push({
        cmd: `/${entry.name.slice(0, -3)}`,
        desc: claudeCommandDesc(text),
        run: 'prompt',
      });
    } catch { /* битый файл — пропускаем */ }
  }
  return commands;
}

// ── MCP-серверы: что видит агент этого CLI ───────────────────────────────────
// Список отдаёт только сам CLI (`claude mcp list`) и только текстом — машинного
// формата у команды нет. Строка выглядит так:
//   <имя>: <команда или URL> - ✔ Connected
//   <имя>: <команда или URL> - ✘ Failed to connect — -32000: …
// Статус отделяем ПО МАРКЕРУ, а не по последнему « - »: в команде запуска дефисов
// хватает (`docker run -i --rm …`), а текст ошибки содержит что угодно.
const MCP_STATUS_AT = /\s+-\s+(?=[✓✔✗✘⚠]|Connected\b|Failed\b|Disconnected\b|Needs\b|Authenticat)/u;
const MCP_ICONS = /^[✓✔✗✘⚠\s]+/u;

/**
 * Разбор `claude mcp list` в записи { name, target, state, detail }.
 * Незнакомый статус — 'unknown', а не выдуманный «ок»: строку CLI могут поменять,
 * и лучше честный прочерк, чем зелёная галка над мёртвым сервером.
 */
export function parseClaudeMcpList(text) {
  const servers = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Checking MCP server health/i.test(line)) continue;

    const at = line.search(MCP_STATUS_AT);
    if (at < 0) continue;
    const head = line.slice(0, at);
    const status = line.slice(at).replace(/^\s+-\s+/, '').trim();

    const sep = head.indexOf(':');
    if (sep <= 0) continue;
    const name = head.slice(0, sep).trim();
    if (!name) continue;

    let state = 'unknown';
    if (/fail|error|disconnect|closed/i.test(status)) state = 'failed';
    else if (/needs?\s+auth|authenticat|unauthor/i.test(status)) state = 'needs-auth';
    else if (/connected/i.test(status)) state = 'ok';

    servers.push({
      name,
      target: head.slice(sep + 1).trim(),
      state,
      detail: status.replace(MCP_ICONS, '').trim(),
    });
  }
  return servers;
}

/**
 * Откуда сервер взят. Определения аккаунтных коннекторов claude.ai локально НЕТ
 * (в конфиге остаётся только имя), поэтому «не нашли в файлах» = аккаунтный:
 * это единственный доступный признак, зато он не врёт про свои же файлы.
 */
export function classifyMcpScope(name, { userServers = [], projectServers = [] } = {}) {
  if (projectServers.includes(name)) return 'project';
  if (userServers.includes(name)) return 'user';
  return 'account';
}

/**
 * Аккаунтные коннекторы claude.ai. В `claude mcp list` их НЕТ — проверено живьём:
 * команда печатает только серверы из файлов, а коннекторы аккаунта не упоминает вовсе.
 * Значит без этого списка секция «claude.ai» в панели была бы пуста навсегда, хотя в
 * расширении VS Code она есть. Единственный локальный след — имена в
 * `claudeAiMcpEverConnected` конфига CLI; ни определения, ни живой проверки у нас нет,
 * поэтому «подключён» здесь не пишем: достоверно известно только «нужна авторизация»
 * из отдельного кэша CLI. Состояние остальных знает claude.ai, и мы честно так и говорим.
 */
export function claudeAiConnectors(userConfig, needsAuthNames = []) {
  const names = Array.isArray(userConfig?.claudeAiMcpEverConnected)
    ? userConfig.claudeAiMcpEverConnected
    : [];
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const needsAuth = needsAuthNames.includes(name);
    out.push({
      name,
      target: '',
      scope: 'account',
      state: needsAuth ? 'needs-auth' : 'remote',
      detail: needsAuth ? 'Needs authentication' : '',
    });
  }
  return out;
}

/**
 * Итоговый список для панели: разобранный вывод CLI + коннекторы аккаунта из конфига.
 * Вынесено отдельно от `mcpStatus`, потому что вся правка состояний здесь, а сам
 * `mcpStatus` — это запуск CLI и чтение трёх файлов.
 */
export function composeMcpServers({
  servers = [], userServers = [], projectServers = [], needsAuthNames = [], userConfig = null,
} = {}) {
  const listed = servers.map((s) => {
    // Провал важнее: сервер, который не поднялся, авторизацией не лечится.
    const needsAuth = s.state !== 'failed' && needsAuthNames.includes(s.name);
    return {
      ...s,
      scope: classifyMcpScope(s.name, { userServers, projectServers }),
      state: needsAuth ? 'needs-auth' : s.state,
      // Такой коннектор список печатает как Connected — соединение и правда есть,
      // инструментов у агента всё равно нет. Оставь текст CLI, и панель скажет
      // «Нужна авторизация», а строкой ниже — «Connected».
      detail: needsAuth ? 'Needs authentication' : s.detail,
    };
  });
  const known = new Set(listed.map((s) => s.name));
  return [
    ...listed,
    ...claudeAiConnectors(userConfig, needsAuthNames).filter((s) => !known.has(s.name)),
  ];
}

// Имена без определения читаются из конфига CLI; кокпит его только ЧИТАЕТ.
async function readJsonQuiet(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export default {
  id: 'claude',
  name: 'Claude',
  vendor: 'Anthropic',
  color: '#d97757',
  order: 1,
  install: 'npm i -g @anthropic-ai/claude-code && claude login',

  // Свои настройки Claude — плашка «Настройки → Исполнители». Список объявляет сам
  // исполнитель: у каждого ИИ ручки разные, UI про вендоров не знает и рисует по kind.
  // Ручка живая: выбор хранится в prefs и передаётся каждому headless-запуску через
  // `--settings {"fastMode":…}`. Доступность режима окончательно проверяет сам CLI.
  settings: [
    {
      id: 'fastMode',
      kind: 'toggle',
      label: 'Ускоренный вывод',
      hint: 'Fast mode ускоряет выдачу той же модели без подмены на более слабую. '
        + 'Доступность и возможное списание usage credits определяет установленный Claude CLI.',
      value: false,
    },
  ],

  // Порог автокомпакта. Переменная перебивает и настройку самого CLI, и окно модели —
  // именно это нужно кокпиту: на модели с окном 1M собственный порог CLI ~950k, а
  // дорого становится с ~250k (см. chatAutoCompactWindow в lib/prefs-store.js).
  autoCompactEnv: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',

  // Родной компакт: слэш-команда работает и в режиме `-p --resume`; в сессии появляются
  // compact_boundary/isCompactSummary, id разговора
  // не меняется. НО stdout такого хода ПУСТОЙ (весь вывод команды локальный), поэтому
  // текст для ленты чата подставляет вызывающий, а не CLI.
  compaction: { kind: 'native', message: '/compact' },

  bin(config) { return config.claudeBin; },

  async commands() {
    return [...CLAUDE_BUILTIN_COMMANDS, ...await scanClaudeUserCommands()];
  },

  /**
   * Состояние MCP-серверов этого CLI для плашки исполнителя.
   * Команда делает НАСТОЯЩИЙ health-check (замер: 3–4 с, на мёртвом сервере дольше),
   * поэтому метод ленивый: он вызывается только своим эндпоинтом, а не общим
   * реестром `/api/providers` — иначе каждый ответ реестра ждал бы эти секунды.
   * «Нужна авторизация» из вывода списка НЕ ВИДНО (коннектор показан там как
   * Connected), этот признак CLI держит отдельным кэшем — читаем и его, иначе
   * панель молчала бы ровно о том сервере, которым агент воспользоваться не может.
   */
  async mcpStatus(config) {
    const out = await exec(config.claudeBin, ['mcp', 'list'], { timeout: 60_000, anyExit: true });
    const text = String(out || '');
    const servers = parseClaudeMcpList(text);

    // Пусто и без явного «серверов нет» — это сбой запуска CLI, а не пустой список.
    if (!servers.length && !/no mcp servers/i.test(text)) {
      const error = text.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300);
      return { state: 'error', error: error || 'CLI не ответил на `mcp list`', servers: [] };
    }

    const [userConfig, projectConfig, needsAuth] = await Promise.all([
      readJsonQuiet(path.join(os.homedir(), '.claude.json')),
      readJsonQuiet(path.join(config.rootDir || process.cwd(), '.mcp.json')),
      readJsonQuiet(path.join(claudeConfigDir(), 'mcp-needs-auth-cache.json')),
    ]);

    const userServers = Object.keys(userConfig?.mcpServers || {});
    const projectServers = [
      ...Object.keys(projectConfig?.mcpServers || {}),
      ...Object.keys(userConfig?.projects?.[config.rootDir]?.mcpServers || {}),
    ];
    const needsAuthNames = Object.keys(needsAuth || {});

    return {
      state: 'ok',
      servers: composeMcpServers({
        servers, userServers, projectServers, needsAuthNames, userConfig,
      }),
    };
  },

  async probe(config) {
    const out = await exec(config.claudeBin, ['--version'], { timeout: 10_000 });
    return { ok: out !== null, version: out ? out.trim().slice(0, 60) : null };
  },

  /**
   * Авторизация — через ClaudeAuthStore кокпита (apikey/env/cli/none).
   */
  auth(config, { claudeAuth }) {
    const mode = claudeAuth?.publicView().mode || 'none';
    const labels = {
      apikey: 'API-ключ кокпита',
      env: 'ANTHROPIC_API_KEY окружения',
      cli: 'CLI хоста (claude login)',
      none: 'не авторизован',
    };
    return { mode, label: labels[mode] || mode, available: mode !== 'none' };
  },

  /**
   * Уровни эффорта — из списка допустимых значений `--effort` в `claude --help`:
   * добавит Anthropic новый уровень — подхватится без правок кода.
   */
  async efforts(config) {
    const out = await exec(config.claudeBin, ['--help']);
    return parseClaudeEfforts(out);
  },

  /**
   * Режимы прав (`--permission-mode`). В `--help` этого флага нет, зато CLI сам
   * перечисляет допустимые значения в ошибке валидации — спрашиваем его заведомо
   * неверным значением и парсим ответ. Появится новый режим — подхватится сам.
   * Подписи наши (CLI их не отдаёт); незнакомый режим показывается как есть.
   */
  async modes(config) {
    const out = await exec(config.claudeBin, ['-p', 'x', '--permission-mode', '__ask__'], { anyExit: true });
    const m = (out || '').match(/Allowed choices are ([^.\n]+)/i);
    if (!m) return null;
    const ids = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return null;
    return ids
      .map((id) => ({ id, order: 99, label: id, hint: '', ...(MODE_LABELS[id] || {}) }))
      .sort((a, b) => a.order - b.order);
  },

  /**
   * Потребление лимитов подписки (как /usage в CLI): прогрессбары «Сессия (5ч)»,
   * «Неделя» и пр. Ручка OAuth-подписки — работает только с токеном хостового CLI
   * (~/.claude/.credentials.json); пользователь явно попросил эту статистику.
   */
  async usage(config) {
    return classifyClaudeUsageResponse(await fetchClaudeUsage({
      claudeBin: config.claudeBin,
      oauthClientId: config.claudeOauthClientId,
      oauthTokenUrl: config.claudeOauthTokenUrl,
    }));
  },

  /**
   * Mutating account actions are an explicit adapter-owned allow-list. Core sees
   * only the action id and never branches on Claude, Codex or a future Kimi.
   */
  usageActions: {
    'configure-extra-usage': ({ payload, config }) => configureClaudeExtraUsage(payload, config),
  },

  /**
   * Живой список моделей из Anthropic API (/v1/models) — так «Fable 6» появится сам.
   * Авторизация: ANTHROPIC_API_KEY из окружения, либо (ТОЛЬКО при явном опт-ине
   * config.discoverWithCliToken) OAuth-токен хостового CLI. Нет ни того ни другого → null,
   * реестр живёт на редактируемом models.json.
   */
  async discoverModels(config) {
    let headers = null;
    if (process.env.ANTHROPIC_API_KEY) {
      headers = { 'x-api-key': process.env.ANTHROPIC_API_KEY };
    } else if (config.discoverWithCliToken) {
      try {
        const creds = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
        const tok = creds?.claudeAiOauth?.accessToken;
        if (tok) headers = { Authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20' };
      } catch { /* кредов нет — обнаружение недоступно */ }
    }
    if (!headers) return null;
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'anthropic-version': '2023-06-01', ...headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id, createdAt: m.created_at || '' }));
  },

  /**
   * Каталог моделей УСТАНОВЛЕННОГО CLI (скан бинаря; имена выводятся из id).
   * Пересобирается при смене версии CLI — новые модели появляются сами, а имена
   * никогда не расходятся с реальностью («Opus 4.8» при opus → claude-opus-4-6).
   */
  catalog(config) {
    return claudeCatalog(config);
  },

  /** Стабильное семейство для policy агентов и движка. */
  modelFamily(model) {
    const explicit = String(model?.family || '').trim();
    if (explicit) return explicit;
    const id = String(model?.id || '').trim();
    const versioned = /^claude-(opus|sonnet|haiku|fable)-/.exec(id);
    if (versioned) return versioned[1];
    return ['opus', 'sonnet', 'haiku'].includes(id) ? id : '';
  },

  /**
   * Класс семейства — для сверки рекомендаций глобальных шаблонов агентов с
   * политикой профиля. Шаблон хранит класс («нужен рассуждающий»), профиль —
   * конкретное семейство; сопоставить их может только тот, кто знает свои модели.
   * Fable и Opus в одном классе намеренно: класс говорит о требуемой силе узла,
   * а какой моделью её закрыть — решает runners.env проекта.
   */
  familyClass(family) {
    return {
      opus: 'reasoning', fable: 'reasoning', sonnet: 'balanced', haiku: 'cheap',
    }[String(family || '').trim().toLowerCase()] || '';
  },

  /**
   * Обновление CLI (кнопка «Обновить» в настройках → «Исполнители»).
   * Само не запускается — только по нажатию пользователя.
   */
  updateCmd: ['install', 'latest'],

  /**
   * Последняя опубликованная версия — для индикатора «доступно обновление».
   * Нативная сборка и npm-пакет идут под одним номером, поэтому реестра достаточно.
   */
  latestVersion() {
    return npmLatest('@anthropic-ai/claude-code');
  },

  /**
   * Стартовый сид — только на случай, если каталог не прочитался (нет бинаря).
   * Никаких версий в подписях: алиасы CLI резолвит сам.
   */
  seedModels() {
    return [
      { id: 'opus', family: 'opus', name: 'Opus — последняя', context: 200000, tier: 8995, efforts: null, alias: true },
      { id: 'sonnet', family: 'sonnet', name: 'Sonnet — последняя', context: 200000, tier: 6995, efforts: null, alias: true },
      { id: 'haiku', family: 'haiku', name: 'Haiku — последняя', context: 200000, tier: 3995, efforts: null, alias: true },
    ];
  },

  /**
   * Запуск: claude -p с резюмом сессии, MCP-конфигом всплывашки разрешений и т.д.
   * Вывод — stream-json: по ходу работы считаем потраченные токены (onProgress →
   * «думает… · N ток.») и разбираем события в ШАГИ (onStep → лента инструментов
   * и размышлений в чате, как в VS Code).
   * Возвращает { reply, sessionId, contextTokens, cost, actualModel, steps } или бросает Error.
   */
  run({ config, env, message, cwd, extraDirs = [], model, effort, sessionId, permissionMode, mcpConfig, permissionPromptTool, providerSettings, log, onProgress, onStep, signal }) {
    const args = ['-p', message, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode || 'default'];
    args.push(...claudeProviderSettingsArgs(providerSettings));
    if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig));
    if (permissionPromptTool) args.push('--permission-prompt-tool', permissionPromptTool);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (sessionId) args.push('--resume', sessionId);
    for (const d of extraDirs) args.push('--add-dir', d);

    return new Promise((resolve, reject) => {
      let resultEv = null;
      let spentTokens = 0;
      let lastTurnInput = 0;
      let buf = '';
      // Лента шагов хода: копим на сервере (уедет в историю чата) и параллельно
      // отдаём наружу через onStep — окно рисует их по мере поступления.
      const stepSink = createStepSink(onStep);
      const { steps } = stepSink;
      // Модель, которой CLI ФАКТИЧЕСКИ отработал: алиас `opus` он резолвит сам,
      // и это единственный способ увидеть рассинхрон с выбором в кокпите.
      let actualModel = '';
      // id сессии CLI ловим ИЗ ПОТОКА, а не только из финального result: у оборванного
      // хода (кнопка «стоп», лимит) результата нет, и без этого id новая сессия оставалась
      // безымянной — следующий вопрос уходил без --resume, и агент забывал разговор.
      let streamSessionId = '';
      const pushSteps = (ev) => {
        stepSink.emitAll(toClaudeSteps(ev));
      };
      // Своего таймаута у процесса НЕТ: лимит хода считает watchdog в modules/chat —
      // только он знает, что агент не работает, а ждёт ответа человека (это время не в счёт).
      // signal — и кнопка «стоп», и тот самый лимит: Node убивает процесс, мы отличаем
      // остановку по коду ошибки (ABORT_ERR) и возвращаем понятный текст, а не «код null».
      const child = execFile(config.claudeBin, args, { cwd, env, maxBuffer: 64 * 1024 * 1024, signal }, (err, stdout, stderr) => {
        // Подстраховка: финальная строка могла остаться в буфере без \n.
        if (!resultEv) {
          for (const line of (buf + '\n' + (stdout || '')).split('\n')) {
            const t = line.trim();
            if (!t.startsWith('{')) continue;
            try { const ev = JSON.parse(t); if (ev.type === 'result') resultEv = ev; } catch { /* мусор */ }
          }
        }
        if (!resultEv) {
          if (err?.code === 'ABORT_ERR' || signal?.aborted) {
            const stopped = new Error('Ход остановлен.');
            stopped.stopped = true;
            stopped.steps = steps;
            // Сессия оборванного хода — живая: по ней продолжится следующий вопрос.
            stopped.sessionId = streamSessionId || sessionId || null;
            // Размер контекста у оборванного хода известен: его сообщил поток. Без него
            // кольцо после «стопа» показывало прежнюю (а у свежей сессии — нулевую) цифру,
            // и чат с реальными 80k выглядел пустым.
            stopped.contextTokens = lastTurnInput;
            return reject(stopped);
          }
          if (err?.killed) return reject(new Error('Процесс агента убит извне (сигнал или переполнение буфера вывода).'));
          const tail = (stderr || '').trim().slice(-600);
          return reject(new Error(tail || `claude завершился без результата (код ${err?.code ?? '?'})`));
        }
        const j = resultEv;
        // Размер контекста = входные токены ПОСЛЕДНЕГО хода (из потока assistant-событий).
        // result.usage — это СУММА за все ходы, она может многократно превышать окно.
        const contextTokens = lastTurnInput || ((u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0))(j.usage || {});
        // Пустой result — агент завершил ход без текста (не разрешили действие, лимит шагов).
        let reply = j.result || '';
        // Ход, в котором не случилось НИ ОДНОГО хода модели: CLI умер на старте.
        // Такой запуск ничего не сделал и ничего не стоил — его безопасно повторить,
        // чем и пользуется чат (см. modules/chat: один автоповтор).
        const emptyRun = !reply && !j.num_turns;
        if (!reply) {
          log?.warn({ subtype: j.subtype, turns: j.num_turns, denials: j.permission_denials, stderr: (stderr || '').trim().slice(-400) },
            'чат: пустой result от claude');
          // AskUserQuestion кокпит «отклоняет» намеренно — так ответ пользователя доезжает
          // до агента (см. modules/chat). Это не отказ в действии, в текст его не тащим.
          const denied = [...new Set((j.permission_denials || []).map((d) => d.tool_name).filter((n) => n && n !== 'AskUserQuestion'))];
          // Причину показываем ЧЕЛОВЕКУ, а не только в журнале: «повтори вопрос» без диагноза
          // загоняет в петлю повторов (инцидент 27.07: три повтора подряд, каждый — новый
          // процесс на занятую сессию, все с error_during_execution).
          const why = j.subtype && j.subtype !== 'success' ? ` (${j.subtype})` : '';
          const tail = (stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(-300);
          const cliNote = tail ? `\n\nCLI сказал: ${tail}` : '';
          if (j.subtype === 'error_max_turns') reply = '⚠ Агент упёрся в лимит шагов и не успел сформулировать ответ. Переформулируй запрос или разбей его на части.';
          else if (denied.length) reply = `⚠ Действия не были разрешены (${denied.join(', ')}) — агент завершил ход без ответа. Разреши действие во всплывашке или переформулируй запрос.`;
          else if (emptyRun) reply = `⚠ Агент не начал работу${why}: ни одного шага, ход пуст. Обычно это упавший запуск CLI — нет сети/VPN, лимит Anthropic или занятая сессия.${cliNote}`;
          else reply = `⚠ Агент завершил ход без текстового ответа${why}. Повтори вопрос — контекст сохранён.${cliNote}`;
        }
        resolve({
          reply, sessionId: j.session_id || sessionId || null, cost: j.total_cost_usd ?? null,
          contextTokens, actualModel, steps, emptyRun, subtype: j.subtype || '',
        });
      });
      // stdin не используем — закрываем сразу, иначе claude ждёт ввода (3с warning, бывают зависания).
      child.stdin?.end();
      // Стрим-парсер: считаем output-токены по assistant-событиям, ловим финальный result.
      child.stdout?.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          pushSteps(ev);
          // session_id CLI проставляет во всех событиях хода, начиная с init. Забираем сразу:
          // если ход оборвут, финального result не будет, а продолжать разговор всё равно нужно.
          if (ev.session_id) streamSessionId = ev.session_id;
          if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
            actualModel = ev.model;
          } else if (ev.type === 'assistant' && ev.message?.usage && ev.message.model !== SYNTHETIC_MODEL) {
            const mu = ev.message.usage;
            spentTokens += mu.output_tokens || 0;
            // Полный id модели хода (с датой сборки) точнее, чем алиас из init.
            if (ev.message.model) actualModel = ev.message.model;
            // Входные токены последнего хода — реальная заполненность окна контекста.
            lastTurnInput = (mu.input_tokens || 0) + (mu.cache_read_input_tokens || 0) + (mu.cache_creation_input_tokens || 0);
            try { onProgress?.(spentTokens); } catch { /* прогресс не критичен */ }
          } else if (ev.type === 'result') {
            resultEv = ev;
          }
        }
      });
    });
  },
};
