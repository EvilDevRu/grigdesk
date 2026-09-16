// Исполнитель Claude (Anthropic, Claude Code CLI).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeCatalog,
  claudeCatalogCacheKey,
  claudeOauthMetadata,
} from './_claudeCatalog.ts';
import { npmLatest } from './_npmLatest.ts';
import { withRetry } from '../retry.ts';
import { contextCacheStatus } from '../chat/contextCache.ts';
import {
  CLAUDE_DIRECT_SSH_DENY,
  DIRECT_SSH_HOOK_COMMAND,
  DIRECT_SSH_HOOK_MATCHER,
  directCommandHook,
  directSshSetting,
} from './_directSshPolicy.ts';
import {
  buildClaudeTurnResult,
  claudeSessionArgs,
  createClaudeTurnCollector,
  openClaudeStreamSession,
} from './_claudeStream.ts';
import { defaultWorkToolDescriptors } from './work-tools/index.ts';
import type { ChatStep } from '../chat/streamSteps.ts';

// Журнал сервера в том минимуме, который использует ход. Та же форма, что у потока.
interface StreamLog {
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

// Серверный config в объёме, который читает исполнитель. Полная его форма
// объявлена в config.ts; адаптер получает его целиком и разбирает сам.
type ClaudeConfig = {
  claudeBin: string;
  claudeOauthClientId?: string;
  claudeOauthTokenUrl?: string;
  rootDir?: string;
  discoverWithCliToken?: unknown;
};

// Сохранённые ручки исполнителя из prefs: их состав объявляет он же.
interface ClaudeSettings {
  blockDirectSsh?: unknown;
  blockDirectDb?: unknown;
  strictUnknownDbClient?: unknown;
  fastMode?: unknown;
}

// OAuth-пара хостового CLI из ~/.claude/.credentials.json. Кокпит её только читает
// и обновляет тем же способом, что и сам CLI.
interface ClaudeOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: unknown;
  scopes?: unknown;
  clientId?: string;
  tokenUrl?: string;
  [field: string]: unknown;
}

interface ClaudeCredentials {
  claudeAiOauth?: ClaudeOauth;
  [field: string]: unknown;
}

// Итог получения токена: что удалось и почему нет. `invalid` отличает мёртвую
// авторизацию (пора логиниться) от временного сбоя обновления.
interface ClaudeTokenResult {
  token: string | null;
  hasCredentials: boolean;
  refreshable: boolean;
  error?: string;
  invalid: boolean;
}

// Ответ ручки обновления токена. Значения недоверенные — проверяются на месте.
interface OauthRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

// Сырое чтение ручки лимитов в том виде, в котором его разбирает классификатор.
interface ClaudeUsageRead {
  hasToken: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  retryAfter?: string | null;
}

// Блок доплаты сверх лимитов подписки в ответе ручки потребления.
interface ExtraUsage {
  decimal_places?: number;
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
  utilization?: unknown;
  currency?: string;
  disabled_reason?: unknown;
  spend_limit_reached?: unknown;
}

// Полоса лимита для всплывашки: ведро, подпись и процент.
interface ClaudeUsageBar {
  key: string;
  group: string;
  label: string;
  pct: number;
  resetsAt: string | null;
  // Длина окна в минутах: по ней прогноз отличает неделю от сессии.
  windowMinutes: number | null;
}

// Запись MCP-сервера для панели исполнителя.
interface ClaudeMcpServer {
  name: string;
  target: string;
  state: string;
  detail: string;
  scope?: string;
  hint?: string;
}

// Картинка недоверенного обращения: границу triage она уже прошла.
interface UntrustedImage {
  mediaType?: unknown;
  data?: unknown;
}

// Ограниченная рабочая область хода: какие корни читаемы и записываемы и какие
// инструменты вообще разрешены этому запуску.
interface WorkspaceAccess {
  readableRoots?: readonly unknown[];
  writableRoots?: readonly unknown[];
  tools?: readonly string[];
}

/**
 * probe/efforts гоняют CLI — короткие таймауты, ошибки не роняют реестр.
 * anyExit: вернуть вывод даже при ненулевом коде — так читается текст ошибки
 * валидации (в нём CLI перечисляет допустимые значения флага).
 */
function exec(bin: string, args: readonly string[], { timeout = 15_000, anyExit = false }: {
  timeout?: number;
  anyExit?: boolean;
} = {}): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, [...args], { timeout }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout || '');
      resolve(anyExit ? `${stdout || ''}\n${stderr || ''}` : null);
    });
  });
}

export function parseClaudeEfforts(help: unknown) {
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
const MODE_LABELS: Record<string, { order: number; label: string; hint: string }> = {
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

// ── Лимиты подписки и доплата сверх них (в CLI это `/usage` и `/usage-credits`) ──
// Ручки приватные, OAuth-подписочные: работают только с токеном хостового CLI
// (~/.claude/.credentials.json), API-ключ тут не годится. Контракт снят с бинаря
// установленного CLI — Anthropic его не документирует, поэтому ошибки НЕ глотаем:
// поменяют ручку — человек должен увидеть, что именно отвалилось.
const API = 'https://api.anthropic.com';
const OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Срок model-only хода по умолчанию: триаж Входящих и название коммита короткие.
const UNTRUSTED_TIMEOUT_MS = 5 * 60 * 1000;
// Дефолтный месячный потолок при первом включении доплаты — как у CLI (2000 = 20.00).
const DEFAULT_LIMIT_MINOR = 2000;

function defaultCredentialsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

async function readCliCredentials(credentialsPath: string): Promise<ClaudeCredentials | null> {
  try {
    return JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  } catch {
    return null;
  }
}

function tokenNeedsRefresh(oauth: ClaudeOauth | null | undefined, now: number) {
  if (!oauth?.accessToken) return true;
  const expiresAt = Number(oauth.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now + OAUTH_REFRESH_SKEW_MS;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Claude Code вращает refresh token и защищает это общей директорией-lock.
 * Используем тот же lock, иначе одновременный ход CLI и фоновая проверка Cockpit
 * могут оба обновить один refresh token и затереть рабочие credentials.
 */
async function acquireOauthRefreshLock(credentialsPath: string, sleep = wait) {
  const lockPath = path.join(path.dirname(credentialsPath), '.oauth_refresh.lock');
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      return async () => {
        try { await fs.rmdir(lockPath); } catch { /* lock уже снят */ }
      };
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'EEXIST') throw error;
      await sleep(250);
    }
  }
  return null;
}

async function writeCliCredentials(credentialsPath: string, credentials: unknown) {
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

function refreshFailure({ hasCredentials = true, refreshable = true, error, invalid = false }: {
  hasCredentials?: boolean;
  refreshable?: boolean;
  error?: string;
  invalid?: boolean;
}): ClaudeTokenResult {
  return { token: null, hasCredentials, refreshable, error, invalid };
}

async function oauthRefreshConfig(oauth: ClaudeOauth | null | undefined, {
  claudeBin,
  oauthClientId,
  oauthTokenUrl,
}: {
  claudeBin?: string;
  oauthClientId?: string;
  oauthTokenUrl?: string;
}): Promise<{ clientId?: string; tokenUrl?: string; error?: string }> {
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
}: {
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  forceRefresh?: boolean;
  failedAccessToken?: string | null;
  claudeBin?: string;
  oauthClientId?: string;
  oauthTokenUrl?: string;
} = {}): Promise<ClaudeTokenResult> {
  let credentials = await readCliCredentials(credentialsPath);
  // Пустой объект вместо отсутствия: наличие пары уже проверено ниже одним местом,
  // и каждое поле не обязано повторять эту проверку заново.
  let oauth: ClaudeOauth = credentials?.claudeAiOauth || {};
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
      token: oauth.accessToken ?? null,
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
      error: 'oauth_refresh_lock_'
        + String((error as { code?: unknown } | null)?.code || 'failed').toLowerCase(),
    });
  }
  if (!release) {
    credentials = await readCliCredentials(credentialsPath);
    oauth = credentials?.claudeAiOauth || {};
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
    oauth = credentials?.claudeAiOauth || {};
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
    const scopes = (Array.isArray(oauth.scopes) ? oauth.scopes.filter(Boolean) : []) as string[];
    let response: Response;
    try {
      const body: Record<string, unknown> = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: refreshConfig.clientId,
      };
      if (scopes.length) body.scope = scopes.join(' ');
      response = await fetchImpl(String(refreshConfig.tokenUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return refreshFailure({ error: (error as Error)?.message || 'oauth_refresh_network_error' });
    }

    const data = await response.json().catch(() => null) as OauthRefreshResponse | null;
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
    const nextOauth: ClaudeOauth = {
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
      token: nextOauth.accessToken ?? null,
      hasCredentials: true,
      refreshable: true,
      error: '',
      invalid: false,
    };
  } finally {
    await release();
  }
}

async function cliToken(options: Parameters<typeof resolveClaudeCliToken>[0]) {
  return (await resolveClaudeCliToken(options)).token;
}

function authHeaders(tok: string) {
  return {
    Authorization: `Bearer ${tok}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  };
}

/**
 * Сырой ответ ручки потребления. Сеть до api.anthropic.com бывает нестабильна (VPN),
 * поэтому запрос идёт через общий `withRetry` — там же живут правила пауз.
 *
 * Повтор безопасен только для сетевых и серверных сбоев. 401/403/429 — самостоятельные
 * состояния интерфейса: повтор их не изменит, а человека задержит. Читающая ручка
 * идемпотентна, ничего не расходует — право на повтор у неё есть.
 */
async function requestUsage(tok: string, fetchImpl: typeof fetch, sleep = wait): Promise<{
  response: Response | null;
  error: string;
}> {
  try {
    const response = await withRetry(() => fetchImpl(`${API}/api/oauth/usage`, {
      headers: authHeaders(tok),
      signal: AbortSignal.timeout(10_000),
    }), {
      retryWhen: (r: Response) => r.status >= 500,
      sleep,
    });
    return { response, error: '' };
  } catch (error) {
    return { response: null, error: (error as Error)?.message || '' };
  }
}

async function usageResponse(result: {
  response: Response | null;
  error: string;
}): Promise<ClaudeUsageRead> {
  const r = result.response;
  if (!r) return { hasToken: true, status: 0, error: result.error || 'network_error' };
  const text = await r.text().catch(() => '');
  let data: unknown = null;
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
}: {
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  claudeBin?: string;
  oauthClientId?: string;
  oauthTokenUrl?: string;
} = {}): Promise<ClaudeUsageRead> {
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

  let result = await requestUsage(auth.token, fetchImpl, sleep);
  if (result.response?.status === 401 && auth.refreshable) {
    const refreshed = await resolveClaudeCliToken({
      ...tokenOpts,
      forceRefresh: true,
      failedAccessToken: auth.token,
    });
    if (refreshed.token && refreshed.token !== auth.token) {
      result = await requestUsage(refreshed.token, fetchImpl, sleep);
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
function creditsOf(d: unknown) {
  const x = (d as { extra_usage?: ExtraUsage } | null)?.extra_usage;
  if (!x) return null;
  const minor = 10 ** (x.decimal_places ?? 2);
  const num = (v: unknown) => (typeof v === 'number' ? v / minor : null);
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
    // Сервис сам сообщает, что месячный потолок выбран. Выводить это из `used >= limit`
    // нельзя: у выключенной доплаты и у режима «без потолка» чисел может не быть вовсе.
    limitReached: x.spend_limit_reached === true,
  };
}

// Суммы в подписи: целые — без копеек, дробные — с двумя знаками.
const money = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function creditsNote(c: NonNullable<ReturnType<typeof creditsOf>>) {
  if (!c.enabled) return 'выключено';
  if (c.unlimited) return 'без месячного потолка';
  if (c.limit == null || c.used == null) return '';
  return `${money(c.used)} из ${money(c.limit)} ${c.currency}`.trim();
}

/**
 * Канонический источник полос — массив `limits` ответа oauth/usage; порядок в нём
 * задаёт сама Anthropic и он стабилен, поэтому сортировать нечего. Поле `group`
 * отделяет общие вёдра подписки от модельных: всплывашка ставит по нему
 * разделитель, не зная ни про Anthropic, ни про имена семейств.
 */
export function parseClaudeUsagePayload(d: unknown): ClaudeUsageBar[] {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const bars: ClaudeUsageBar[] = [];
  const KIND: Record<string, string> = { session: 'Сессия (5ч)', weekly_all: 'Неделя (7д)' };
  const KIND_MINUTES: Record<string, number> = {
    session: 300,
    weekly_all: 10_080,
    weekly_scoped: 10_080,
  };

  const limits = ((d as { limits?: unknown } | null)?.limits || []) as Array<{
    kind?: string;
    percent?: unknown;
    resets_at?: string;
    scope?: { model?: { display_name?: string }; surface?: string };
  }>;
  for (const l of limits) {
    if (typeof l.percent !== 'number') {
      continue;
    }

    const scoped = l.kind === 'weekly_scoped';
    const scopeName = l.scope?.model?.display_name || l.scope?.surface || '?';
    let label = KIND[String(l.kind)] || String(l.kind || '').replace(/_/g, ' ');

    if (scoped) {
      label = `Неделя · ${scopeName}`;
    }

    bars.push({
      key: String(l.kind) + (l.scope?.model?.display_name || ''),
      group: scoped ? `scoped:${scopeName}` : 'subscription',
      label,
      pct: clamp(l.percent),
      resetsAt: l.resets_at || null,
      windowMinutes: KIND_MINUTES[String(l.kind)] ?? null,
    });
  }

  if (!bars.length) {
    for (const [key, raw] of Object.entries((d || {}) as Record<string, unknown>)) {
      const value = raw as { utilization?: unknown; resets_at?: string } | null;
      if (!value || typeof value !== 'object' || typeof value.utilization !== 'number') {
        continue;
      }

      bars.push({
        key,
        group: 'subscription',
        label: key.replace(/_/g, ' '),
        pct: clamp(value.utilization),
        resetsAt: value.resets_at || null,
        windowMinutes: null,
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
export function parseClaudeUsageResources(d: unknown): Array<Record<string, unknown>> {
  const c = creditsOf(d);
  if (!c) return [];
  const cur = c.currency || 'в валюте счёта';
  return [{
    key: 'extra-usage',
    label: 'Extra usage (доплата)',
    summary: creditsNote(c),
    // Выбранный потолок важнее включённости: доплата формально включена, а работа
    // сверх лимитов подписки уже не пойдёт — молчать об этом нельзя.
    tone: c.limitReached ? 'bad' : (c.enabled ? 'ok' : 'muted'),
    ...(c.enabled && c.utilization !== null
      && { percent: Math.max(0, Math.min(100, Math.round(c.utilization))) }),
    note: [
      c.limitReached ? 'Месячный потолок доплаты выбран — сверх лимитов подписки работа не пойдёт.' : '',
      c.unlimited ? 'Потолка нет — расходы не ограничены сверху.' : '',
      c.disabledReason ? `Причина отказа: ${c.disabledReason}` : '',
    ].filter(Boolean).join(' '),
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

function usageErrorMessage(value: unknown) {
  const data = value as { error?: { message?: string }; message?: string } | null;
  return data?.error?.message || data?.message || '';
}

function retryAtOf(value: unknown, now: number) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? date : null;
}

export function classifyClaudeUsageResponse({
  hasToken,
  status = 0,
  data = null,
  error = '',
  retryAfter = null,
  now = Date.now(),
}: {
  hasToken?: unknown;
  status?: number;
  data?: unknown;
  error?: string;
  retryAfter?: string | null;
  now?: number;
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
async function orgUuid(tok: string): Promise<string | null> {
  try {
    const j = JSON.parse(
      await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8'),
    ) as { oauthAccount?: { organizationUuid?: string } } | null;
    if (j?.oauthAccount?.organizationUuid) return j.oauthAccount.organizationUuid;
  } catch { /* файла нет или он битый — спросим у API */ }
  const r = await fetch(`${API}/api/oauth/profile`, {
    headers: authHeaders(tok),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const d = await r.json().catch(() => null) as {
    organization?: { uuid?: string; organization_uuid?: string };
    account?: { organization_uuid?: string };
  } | null;
  return d?.organization?.uuid || d?.organization?.organization_uuid || d?.account?.organization_uuid || null;
}

/**
 * Вызов организационной ручки: uuid идёт и в путь, и в заголовок (так же делает CLI).
 * Ошибку разворачиваем в текст для человека — у этих ручек он осмысленный
 * («no payment method on file» и т.п.).
 */
async function orgCall(tok: string, org: string, method: string, sub: string, body: unknown) {
  const r = await fetch(`${API}/api/oauth/organizations/${org}${sub}`, {
    method,
    headers: { ...authHeaders(tok), 'x-organization-uuid': org, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((e: Error) => { throw new Error(`сеть недоступна: ${e.message}`); });
  if (r.ok) return r.json().catch(() => ({}));
  const text = await r.text().catch(() => '');
  let msg = '';
  try {
    msg = (JSON.parse(text) as { error?: { message?: string } } | null)?.error?.message || '';
  } catch { /* не JSON — покажем как есть */ }
  throw new Error(`${r.status} ${msg || text.slice(0, 300) || r.statusText}`.trim());
}

/**
 * Configure Claude overage. Kept outside the executor object so the provider
 * action map remains a thin, explicit allow-list rather than a generic RPC.
 */
async function configureClaudeExtraUsage(patch: {
  enabled?: unknown;
  limit?: unknown;
} = {}, config: Partial<ClaudeConfig> = {}) {
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
  const minor = typeof limit === 'number' ? Math.round(limit * state.minor) : null;

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
      const body: Record<string, unknown> = { is_enabled: true };
      if (minor !== null) {
        body.monthly_credit_limit = minor;
        if (state.currency) body.currency = state.currency;
      }
      await orgCall(tok, org, 'PUT', '/overage_spend_limit', body);
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const after = await fetchClaudeUsage(tokenOpts);
  return { ok: true, resource: parseClaudeUsageResources(after.status === 200 ? after.data : null)[0] || null };
}

/**
 * Аргументы coding-запуска Claude. Нативный deny ловит прямую форму, а PreToolUse
 * разбирает basename, wrappers и удалённый rsync; false снимает только оба наших слоя.
 */
export function claudeProviderSettingsArgs(settings: ClaudeSettings = {}, {
  directSshPolicy = true,
}: { directSshPolicy?: boolean } = {}) {
  const blockDirectSsh = directSshPolicy && settings.blockDirectSsh !== false;
  const hookCommand = directCommandHook({
    blockDirectSsh,
    blockDirectDb: settings.blockDirectDb === true,
    strictUnknownDbClient: settings.strictUnknownDbClient === true,
  });
  const payload = {
    fastMode: settings.fastMode === true,
    ...(hookCommand && {
      hooks: {
        PreToolUse: [{
          matcher: DIRECT_SSH_HOOK_MATCHER,
          hooks: [{ type: 'command', command: hookCommand, timeout: 5 }],
        }],
      },
    }),
  };
  return [
    ...(blockDirectSsh ? ['--disallowedTools', ...CLAUDE_DIRECT_SSH_DENY] : []),
    '--settings',
    JSON.stringify(payload),
  ];
}

const CLAUDE_UNTRUSTED_MEDIA_TYPES = Object.freeze([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const CLAUDE_UNTRUSTED_MAX_IMAGES = 20;
// Предел одной строки stream-json на stdin CLI. Больше он не читает и отвечает
// «Input exceeds the maximum length of 1048576 characters» — отказ без указания
// на причину; здесь та же граница проверяется до запуска и называется словами.
export const CLAUDE_UNTRUSTED_MAX_INPUT_CHARS = 1_048_576;

function untrustedInputError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/**
 * Inbox-триаж нельзя запускать обычным coding-ходом. Этот argv полностью выключает
 * built-in tools, project/user customizations, hooks, skills и MCP, не сохраняет
 * сессию и не читает инструкции из cwd. Сеть остаётся только у самого CLI для model
 * transport; у недоверенного prompt нет инструмента, способного ею воспользоваться.
 */
export function buildClaudeUntrustedArgs({ model, effort, providerSettings = {} }: {
  model?: string;
  effort?: string;
  providerSettings?: ClaudeSettings;
} = {}) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // Режим `plan` здесь не подходит: CLI подмешивает в него инструкции о плане и
    // файле плана, и модель на сложном вопросе отвечает «планом» вместо ответа.
    // `dontAsk` не спрашивает разрешений и отклоняет всё, что их требует, а
    // инструментов у хода и так нет.
    '--permission-mode', 'dontAsk',
    '--tools', '',
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--no-session-persistence',
    ...claudeProviderSettingsArgs(providerSettings, { directSshPolicy: false }),
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

/** Изображения передаются байтами в user content, никогда файловыми путями. */
export function buildClaudeUntrustedInput(message: unknown, images: readonly UntrustedImage[] = []) {
  if (!Array.isArray(images) || images.length > CLAUDE_UNTRUSTED_MAX_IMAGES) {
    throw untrustedInputError('attachment_media_limit', 'Слишком много изображений для Claude.');
  }
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: String(message || '') }];
  for (const image of images) {
    if (!CLAUDE_UNTRUSTED_MEDIA_TYPES.includes(String(image?.mediaType))
        || typeof image?.data !== 'string'
        || !image.data) {
      throw untrustedInputError('unsupported_media', 'Claude не поддерживает формат изображения.');
    }
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }
  const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
  if (line.length > CLAUDE_UNTRUSTED_MAX_INPUT_CHARS) {
    throw untrustedInputError(
      'input_too_large',
      `Вход Claude (${Math.round(line.length / 1024)} КБ) превышает предел строки stream-json `
        + `${Math.round(CLAUDE_UNTRUSTED_MAX_INPUT_CHARS / 1024)} КБ: сократите текст или число кадров.`,
    );
  }
  return line;
}

/**
 * Повторы запроса к API, которые CLI успел объявить в stream-json. Убитый по сроку
 * процесс не оставляет result-события, и без этих событий четверть часа тишины
 * неотличима от медленной модели. Сеть до API рвётся сериями по нескольку минут,
 * CLI повторяет запрос до десяти раз с растущей паузой и в срок не укладывается —
 * причина здесь транспорт, а не вход и не модель, и её имеет смысл повторить позже.
 */
function claudeApiRetries(stdout: unknown): { count: number; last: string } {
  let count = 0;
  let last = '';
  for (const line of String(stdout || '').split(/\r?\n/u)) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const event = JSON.parse(candidate) as {
        type?: string;
        subtype?: string;
        error?: unknown;
        error_status?: unknown;
      } | null;
      if (event?.type !== 'system' || event.subtype !== 'api_retry') continue;
      count += 1;
      const status = Number(event.error_status);
      const detail = String(event.error ?? '').trim();
      last = Number.isFinite(status) && status > 0
        ? `HTTP ${status}${detail && detail !== 'unknown' ? ` ${detail}` : ''}`
        : detail && detail !== 'unknown' ? detail : 'обрыв соединения';
    } catch { /* посторонняя строка CLI */ }
  }
  return { count, last };
}

// Текст result-события, которым CLI сообщает, что запрос к API так и не дошёл:
// исчерпанные повторы после обрывов соединения, а не ответ модели по существу.
const CLAUDE_TRANSPORT_LOST =
  /connection to the api was lost|fetch failed|econnreset|etimedout|socket hang up/u;

function claudeUntrustedResult(stdout: unknown, stderr: unknown) {
  let result: {
    result?: unknown;
    total_cost_usd?: unknown;
    model?: unknown;
    is_error?: unknown;
  } | null = null;
  for (const line of String(stdout || '').split(/\r?\n/u)) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const event = JSON.parse(candidate) as {
        type?: string;
        result?: unknown;
        total_cost_usd?: unknown;
        model?: unknown;
        is_error?: unknown;
      } | null;
      if (event?.type === 'result') result = event;
    } catch { /* посторонняя строка CLI */ }
  }
  if (!result) {
    const retries = claudeApiRetries(stdout);
    if (retries.count > 0) {
      throw untrustedInputError(
        'model_unreachable',
        `Claude завершился без результата после ${retries.count} повторов запроса к API `
          + `(${retries.last}).`,
      );
    }
    const detail = String(stderr || '').trim().slice(-600);
    throw untrustedInputError(
      'model_run_failed',
      detail || 'Claude завершился без результата.',
    );
  }
  const reply = typeof result.result === 'string' ? result.result.trim() : '';
  if (result.is_error === true) {
    const lower = reply.toLowerCase();
    const authFailed = /failed to authenticate|authentication[_\s-]+failed|oauth session expired/u
      .test(lower);
    if (!authFailed && CLAUDE_TRANSPORT_LOST.test(lower)) {
      throw untrustedInputError('model_unreachable', `Claude не дозвонился до API: ${reply}`);
    }
    throw untrustedInputError(
      authFailed ? 'model_auth_failed' : 'model_run_failed',
      authFailed
        ? 'Авторизация Claude истекла и не смогла обновиться. Выполните claude login.'
        : reply || 'Claude завершил model-only ход с ошибкой.',
    );
  }
  if (!reply) {
    throw untrustedInputError('model_run_failed', 'Claude вернул пустой результат.');
  }
  return {
    reply,
    sessionId: null,
    cost: result.total_cost_usd ?? null,
    actualModel: String(result.model || ''),
  };
}

export async function runClaudeUntrusted({
  config, env, message, images = [], model, effort, providerSettings, signal,
  timeoutMs = UNTRUSTED_TIMEOUT_MS,
}: {
  config: ClaudeConfig;
  env?: NodeJS.ProcessEnv;
  message?: unknown;
  images?: readonly UntrustedImage[];
  model?: string;
  effort?: string;
  providerSettings?: ClaudeSettings;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const input = buildClaudeUntrustedInput(message, images);
  const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : UNTRUSTED_TIMEOUT_MS;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-inbox-model-'));
  await fs.chmod(cwd, 0o500);
  try {
    return await new Promise<ReturnType<typeof claudeUntrustedResult>>((resolve, reject) => {
      const child = execFile(config.claudeBin, buildClaudeUntrustedArgs({
        model, effort, providerSettings,
      }), {
        cwd,
        env: {
          ...process.env,
          ...(env || {}),
          CLAUDE_CODE_SAFE_MODE: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        // Inbox обрабатывает недоверенный ввод: ограничиваем не только capabilities,
        // но и ресурсы зависшего/многословного model-only хода. Срок задаёт вызывающий:
        // триажу хватает пяти минут, сценарий ролика на opus с полным effort в них
        // не укладывается.
        maxBuffer: 2 * 1024 * 1024,
        timeout: limitMs,
        killSignal: 'SIGTERM',
        signal,
      }, (error, stdout, stderr) => {
        if (error) {
          // Убитый по сроку процесс не оставляет ни result-события, ни stderr, и
          // прежде выглядел как «завершился без результата» — причина, по которой
          // человек ничего не может сделать. Срок называется явно, а если CLI за
          // это время повторял запрос к API, называется и транспорт: такой срыв
          // не про модель, и вызывающий вправе повторить его после паузы.
          if (error.killed && !signal?.aborted) {
            const minutes = Math.round(limitMs / 60_000);
            const retries = claudeApiRetries(stdout);
            reject(retries.count > 0
              ? untrustedInputError(
                'model_unreachable',
                `Claude не уложился в ${minutes} мин: API не отвечал, CLI повторил запрос `
                  + `${retries.count} раз (${retries.last}).`,
              )
              : untrustedInputError(
                'model_run_failed',
                `Claude не уложился в ${minutes} мин и остановлен.`,
              ));
            return;
          }
          // Claude пишет причину API/авторизации в result-событие stdout и при этом
          // завершается с кодом 1. Разбираем поток до generic ошибки execFile,
          // иначе BuildRun теряет исправимую причину остановки.
          try {
            claudeUntrustedResult(stdout, stderr);
          } catch (resultError) {
            reject(resultError);
            return;
          }
          const detail = String(stderr || '').trim().slice(-600);
          reject(untrustedInputError(
            'model_run_failed',
            detail || error.message || 'Claude не запустился.',
          ));
          return;
        }
        try { resolve(claudeUntrustedResult(stdout, stderr)); } catch (parseError) { reject(parseError); }
      });
      child.stdin?.end(input);
    });
  } finally {
    await fs.chmod(cwd, 0o700).catch(() => {});
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

// Слэш-команды Claude для меню чата. Print-режим (`-p --resume`) перехватывает их сам:
// состав проверен contract gate на claude 2.1.220. /status, /vim и
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
function claudeCommandDesc(text: unknown) {
  const fallback = 'Пользовательская команда';
  const source = String(text || '');
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fm) {
    const line = (fm[1] || '').split(/\r?\n/).find((l) => /^description\s*:/.test(l));
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
  const commands: Array<{ cmd: string; desc: string; run: string }> = [];
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
const CLAUDE_MCP_GROUPS = [{
  id: 'account',
  label: 'claude.ai',
  hint: 'Коннекторы аккаунта настраиваются на claude.ai; CLI не сообщает их живой статус.',
}];

function claudeMcpAuthHint(name: string, scope: string) {
  return scope === 'account'
    ? 'Авторизуется в настройках коннекторов на claude.ai, не из Cockpit.'
    : `Нужен вход: \`claude mcp login ${name}\` в терминале.`;
}

/**
 * Разбор `claude mcp list` в записи { name, target, state, detail }.
 * Незнакомый статус — 'unknown', а не выдуманный «ок»: строку CLI могут поменять,
 * и лучше честный прочерк, чем зелёная галка над мёртвым сервером.
 */
export function parseClaudeMcpList(text: unknown): ClaudeMcpServer[] {
  const servers: ClaudeMcpServer[] = [];
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
export function classifyMcpScope(name: string, { userServers = [], projectServers = [] }: {
  userServers?: readonly string[];
  projectServers?: readonly string[];
} = {}) {
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
export function claudeAiConnectors(
  userConfig: unknown,
  needsAuthNames: readonly string[] = [],
): ClaudeMcpServer[] {
  const config = userConfig as { claudeAiMcpEverConnected?: unknown } | null;
  const names = (Array.isArray(config?.claudeAiMcpEverConnected)
    ? config.claudeAiMcpEverConnected
    : []) as unknown[];
  const seen = new Set<string>();
  const out: ClaudeMcpServer[] = [];
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
      ...(needsAuth ? { hint: claudeMcpAuthHint(name, 'account') } : {}),
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
}: {
  servers?: readonly ClaudeMcpServer[];
  userServers?: readonly string[];
  projectServers?: readonly string[];
  needsAuthNames?: readonly string[];
  userConfig?: unknown;
} = {}): ClaudeMcpServer[] {
  const listed = servers.map((s) => {
    // Провал важнее: сервер, который не поднялся, авторизацией не лечится.
    const needsAuth = s.state !== 'failed' && needsAuthNames.includes(s.name);
    const scope = classifyMcpScope(s.name, { userServers, projectServers });
    return {
      ...s,
      scope,
      state: needsAuth ? 'needs-auth' : s.state,
      // Такой коннектор список печатает как Connected — соединение и правда есть,
      // инструментов у агента всё равно нет. Оставь текст CLI, и панель скажет
      // «Нужна авторизация», а строкой ниже — «Connected».
      detail: needsAuth ? 'Needs authentication' : s.detail,
      ...(needsAuth ? { hint: claudeMcpAuthHint(s.name, scope) } : {}),
    };
  });
  const known = new Set(listed.map((s) => s.name));
  return [
    ...listed,
    ...claudeAiConnectors(userConfig, needsAuthNames).filter((s) => !known.has(s.name)),
  ];
}

// Имена без определения читаются из конфига CLI; кокпит его только ЧИТАЕТ.
async function readJsonQuiet(file: string): Promise<Record<string, unknown> | null> {
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
  scopedWorkspace: true,
  workToolsTransport: 'mcp',
  install: 'npm i -g @anthropic-ai/claude-code && claude login',
  // Официальная страница состояния вендора. Всплывашка ведёт туда, когда лимиты не
  // пришли не по нашей вине: иначе сбой Anthropic человек разбирает как поломку кокпита.
  statusPage: 'https://status.claude.com',
  // Каждый путь из opts.extraDirs становится дополнительным workspace через --add-dir.
  trustedDirectories: true,
  directSshPolicy: { enforcement: 'command-hook' },
  untrustedInput: Object.freeze({
    text: true,
    images: true,
    maxImages: CLAUDE_UNTRUSTED_MAX_IMAGES,
    mediaTypes: CLAUDE_UNTRUSTED_MEDIA_TYPES,
  }),

  // Свои настройки Claude — плашка «Настройки → Исполнители». Список объявляет сам
  // исполнитель: у каждого ИИ ручки разные, UI про вендоров не знает и рисует по kind.
  // Ручка живая: выбор хранится в prefs и передаётся каждому headless-запуску через
  // `--settings {"fastMode":…}`. Доступность режима окончательно проверяет сам CLI.
  settings: [
    directSshSetting(),
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
  // ранний управляемый порог удерживает размер/задержку хода и оставляет запас до окна
  // (см. chatAutoCompactWindow в lib/prefs-store.js).
  autoCompactEnv: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',

  // Родной компакт: слэш-команда работает и в режиме `-p --resume`; в сессии появляются
  // compact_boundary/isCompactSummary, id разговора
  // не меняется. НО stdout такого хода ПУСТОЙ (весь вывод команды локальный), поэтому
  // текст для ленты чата подставляет вызывающий, а не CLI.
  compaction: { kind: 'native', message: '/compact' },

  bin(config: ClaudeConfig) { return config.claudeBin; },

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
  async mcpStatus(config: ClaudeConfig) {
    const out = await exec(config.claudeBin, ['mcp', 'list'], { timeout: 60_000, anyExit: true });
    const text = String(out || '');
    const servers = parseClaudeMcpList(text);

    // Пусто и без явного «серверов нет» — это сбой запуска CLI, а не пустой список.
    if (!servers.length && !/no mcp servers/i.test(text)) {
      const error = text.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300);
      return {
        state: 'error',
        error: error || 'CLI не ответил на `mcp list`',
        servers: [] as ClaudeMcpServer[],
      };
    }

    const [userConfig, projectConfig, needsAuth] = await Promise.all([
      readJsonQuiet(path.join(os.homedir(), '.claude.json')),
      readJsonQuiet(path.join(config.rootDir || process.cwd(), '.mcp.json')),
      readJsonQuiet(path.join(claudeConfigDir(), 'mcp-needs-auth-cache.json')),
    ]);

    const userServers = Object.keys(userConfig?.mcpServers || {});
    const projectServers = [
      ...Object.keys(projectConfig?.mcpServers || {}),
      ...Object.keys((userConfig?.projects as Record<string, {
        mcpServers?: Record<string, unknown>;
      }> | undefined)?.[String(config.rootDir)]?.mcpServers || {}),
    ];
    const needsAuthNames = Object.keys(needsAuth || {});

    return {
      state: 'ok',
      groups: CLAUDE_MCP_GROUPS,
      servers: composeMcpServers({
        servers, userServers, projectServers, needsAuthNames, userConfig,
      }),
    };
  },

  async probe(config: ClaudeConfig) {
    const out = await exec(config.claudeBin, ['--version'], { timeout: 10_000 });
    return { ok: out !== null, version: out ? out.trim().slice(0, 60) : null };
  },

  /**
   * Авторизация — через ClaudeAuthStore кокпита (apikey/env/cli/none).
   */
  auth(config: ClaudeConfig, { claudeAuth }: {
    claudeAuth?: { publicView: () => { mode?: string } };
  } = {}) {
    const mode = claudeAuth?.publicView().mode || 'none';
    const labels: Record<string, string> = {
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
  async efforts(config: ClaudeConfig) {
    const out = await exec(config.claudeBin, ['--help']);
    return parseClaudeEfforts(out);
  },

  /**
   * Какие ступени общего ладдера доступны КОНКРЕТНОЙ модели.
   * `--help` перечисляет все уровни, которые понимает CLI, но принимает их не каждая
   * модель: `--effort xhigh` на Opus 4.6 — не «игнор», а падение с ошибкой валидации.
   * Разрешения объявляет реестр внутри бинаря (`capabilities`), поэтому ни имён
   * уровней, ни списка моделей здесь не зашито: появится новая ступень — её пропустит
   * общий ладдер, появится новая модель — её возможности приедут со своей записью.
   * null — «данных нет», тогда остаётся общий ладдер, как раньше.
   */
  modelEfforts(model: {
    effortUnverified?: unknown;
    capabilities?: unknown;
    effortGates?: unknown;
  } | null | undefined, ladder: readonly string[] | null | undefined) {
    // Частично прочитанная запись не имеет права получить общий ladder: неизвестная
    // ступень не игнорируется CLI, а роняет запуск. Сохранённые metadata остаются в
    // реестре для диагностики/восстановления, но до здорового скана флаг не передаём.
    if (model?.effortUnverified) return [];
    const caps = (Array.isArray(model?.capabilities) ? model.capabilities : null) as string[] | null;
    if (!caps || !Array.isArray(ladder) || !ladder.length) return null;
    // Модель без `effort` вовсе не принимает флаг — слайдер ей не показываем.
    if (!caps.includes('effort')) return [];
    // Какие ступени вообще требуют отдельного разрешения, знает не эта модель, а весь
    // реестр: `effortGates` собран по нему в каталоге. Негейтованная ступень (low,
    // medium, high) доступна всем, у гейтованной обязан быть свой флаг `<уровень>_effort`.
    const gated = (Array.isArray(model?.effortGates) ? model.effortGates : []) as string[];
    return ladder.filter((level) => !gated.includes(level) || caps.includes(`${level}_effort`));
  },

  /**
   * Режимы прав (`--permission-mode`). В `--help` этого флага нет, зато CLI сам
   * перечисляет допустимые значения в ошибке валидации — спрашиваем его заведомо
   * неверным значением и парсим ответ. Появится новый режим — подхватится сам.
   * Подписи наши (CLI их не отдаёт); незнакомый режим показывается как есть.
   */
  async modes(config: ClaudeConfig) {
    const out = await exec(config.claudeBin, ['-p', 'x', '--permission-mode', '__ask__'], { anyExit: true });
    const m = (out || '').match(/Allowed choices are ([^.\n]+)/i);
    if (!m) return null;
    const ids = (m[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
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
  async usage(config: ClaudeConfig) {
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
    'configure-extra-usage': ({ payload, config }: {
      payload?: unknown;
      config?: unknown;
    }) => configureClaudeExtraUsage(
      payload as { enabled?: unknown; limit?: unknown },
      config as Partial<ClaudeConfig>,
    ),
  },

  /**
   * Живой список моделей из Anthropic API (/v1/models) — так «Fable 6» появится сам.
   * Авторизация: ANTHROPIC_API_KEY из окружения, либо (ТОЛЬКО при явном опт-ине
   * config.discoverWithCliToken) OAuth-токен хостового CLI. Нет ни того ни другого → null,
   * реестр живёт на редактируемом models.json.
   */
  async discoverModels(config: ClaudeConfig) {
    let headers: Record<string, string> | null = null;
    if (process.env.ANTHROPIC_API_KEY) {
      headers = { 'x-api-key': process.env.ANTHROPIC_API_KEY };
    } else if (config.discoverWithCliToken) {
      try {
        const creds = JSON.parse(
          await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'),
        ) as ClaudeCredentials | null;
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
    const d = await r.json() as { data?: unknown } | null;
    const models = (d?.data || []) as Array<{ id?: string; display_name?: string; created_at?: string }>;
    return models.map((m) => ({ id: m.id, name: m.display_name || m.id, createdAt: m.created_at || '' }));
  },

  /**
   * Каталог моделей УСТАНОВЛЕННОГО CLI: id сканируются из бинаря, а display name и
   * возможности читаются из встроенного registry (с явным fallback при деградации).
   * Пересобирается при смене версии CLI или catalogCacheKey.
   */
  catalog(config: ClaudeConfig) {
    return claudeCatalog(config);
  },

  catalogCacheKey() {
    return claudeCatalogCacheKey();
  },

  /** Стабильное семейство для policy агентов и движка. */
  modelFamily(model: { family?: unknown; id?: unknown } | null | undefined) {
    const explicit = String(model?.family || '').trim();
    if (explicit) return explicit;
    const id = String(model?.id || '').trim();
    const versioned = /^claude-(opus|sonnet|haiku|fable)-/.exec(id);
    if (versioned) return versioned[1] || '';
    return ['opus', 'sonnet', 'haiku'].includes(id) ? id : '';
  },

  /**
   * Класс семейства — для сверки рекомендаций глобальных шаблонов агентов с
   * политикой профиля. Шаблон хранит класс («нужен рассуждающий»), профиль —
   * конкретное семейство; сопоставить их может только тот, кто знает свои модели.
   * Fable и Opus в одном классе намеренно: класс говорит о требуемой силе узла,
   * а какой моделью её закрыть — решает runners.env проекта.
   */
  familyClass(family: unknown) {
    const classes: Record<string, string> = {
      opus: 'reasoning', fable: 'reasoning', sonnet: 'balanced', haiku: 'cheap',
    };
    return classes[String(family || '').trim().toLowerCase()] || '';
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
      { id: 'opus', family: 'opus', name: 'Opus — последняя', context: 200000, tier: 8995, efforts: null, alias: true, inputModalities: ['text', 'image'] },
      { id: 'sonnet', family: 'sonnet', name: 'Sonnet — последняя', context: 200000, tier: 6995, efforts: null, alias: true, inputModalities: ['text', 'image'] },
      { id: 'haiku', family: 'haiku', name: 'Haiku — последняя', context: 200000, tier: 3995, efforts: null, alias: true, inputModalities: ['text', 'image'] },
    ];
  },

  runUntrusted(options: Parameters<typeof runClaudeUntrusted>[0]) {
    return runClaudeUntrusted(options);
  },

  /**
   * Запуск: claude -p с резюмом сессии, MCP-конфигом всплывашки разрешений и т.д.
   * Вывод — stream-json: по ходу работы считаем потраченные токены (onProgress →
   * «думает… · N ток.») и разбираем события в ШАГИ (onStep → лента инструментов
   * и размышлений в чате, как в VS Code).
   * Возвращает { reply, sessionId, contextTokens, cost, actualModel, steps } или бросает Error.
   */
  run({
    config, env, message, cwd, extraDirs = [], model, effort, sessionId, permissionMode,
    mcpConfig, permissionPromptTool, providerSettings, log, onProgress, onStep, signal,
    workspaceAccess, workTools, onSessionCreated,
  }: {
    config: ClaudeConfig;
    env?: NodeJS.ProcessEnv;
    message?: string;
    cwd?: string;
    extraDirs?: readonly string[];
    model?: string;
    effort?: string;
    sessionId?: string | null;
    permissionMode?: string;
    mcpConfig?: { mcpServers?: Record<string, unknown> } | null;
    permissionPromptTool?: string;
    providerSettings?: ClaudeSettings;
    log?: StreamLog;
    onProgress?: (tokens: number, extra: Record<string, unknown>) => void;
    onStep?: (step: ChatStep) => void;
    signal?: AbortSignal;
    workspaceAccess?: WorkspaceAccess | null;
    workTools?: { descriptors?: unknown } | null;
    onSessionCreated?: (sessionId: string) => unknown;
  }) {
    const args = [
      '-p', String(message ?? ''),
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permissionMode || 'default',
    ];
    const scoped = workspaceAccess && typeof workspaceAccess === 'object';
    const readableRoots: readonly string[] = scoped
      ? [...new Set((workspaceAccess?.readableRoots || []).map(String))]
      : extraDirs;
    const writableRoots: readonly string[] = scoped
      ? [...new Set((workspaceAccess?.writableRoots || []).map(String))]
      : [];
    const accessibleRoots = [...new Set([...readableRoots, ...writableRoots])];
    const protectedRoots = readableRoots.filter((root) => !writableRoots.includes(root));
    const requestedTools = new Set(workspaceAccess?.tools || []);
    const scopedTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit']
      .filter((tool) => requestedTools.has(tool));
    const scopedPermissions = scoped ? {
      permissions: {
        allow: [
          ...accessibleRoots.flatMap((root) => [
            `Read(//${root.replace(/^\/+/, '')}/**)`,
            `Glob(//${root.replace(/^\/+/, '')}/**)`,
            `Grep(//${root.replace(/^\/+/, '')}/**)`,
          ]),
          ...writableRoots.flatMap((root) => [
            `Write(//${root.replace(/^\/+/, '')}/**)`,
            `Edit(//${root.replace(/^\/+/, '')}/**)`,
          ]),
        ],
        deny: protectedRoots.flatMap((root) => [
          `Write(//${root.replace(/^\/+/, '')}/**)`,
          `Edit(//${root.replace(/^\/+/, '')}/**)`,
          `NotebookEdit(//${root.replace(/^\/+/, '')}/**)`,
        ]),
      },
    } : null;
    const providerArgs = claudeProviderSettingsArgs(providerSettings);
    if (scopedPermissions) {
      const settingsAt = providerArgs.lastIndexOf('--settings');
      const current = JSON.parse(providerArgs[settingsAt + 1] || '{}') as Record<string, unknown>;
      providerArgs[settingsAt + 1] = JSON.stringify({ ...current, ...scopedPermissions });
      args.push(
        '--tools', scopedTools.join(','),
        '--strict-mcp-config',
        '--setting-sources', '',
        '--no-session-persistence',
      );
    }
    args.push(...providerArgs);
    if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig));
    if (mcpConfig?.mcpServers?.['cockpit-work']) {
      const descriptors = (Array.isArray(workTools?.descriptors)
        ? workTools.descriptors
        : defaultWorkToolDescriptors('claude')) as Array<{
          name?: string;
          function?: { name?: string };
        }>;
      const allowed = scoped
        ? 'mcp__cockpit-work__repo_history'
        : descriptors
          .map((descriptor) => descriptor?.name || descriptor?.function?.name)
          .filter(Boolean)
          .map((name) => `mcp__cockpit-work__${name}`)
          .join(',');
      if (allowed) {
        args.push('--allowedTools', allowed);
      }
    }
    if (permissionPromptTool) args.push('--permission-prompt-tool', permissionPromptTool);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (sessionId) args.push('--resume', sessionId);
    for (const d of readableRoots) {
      if (d !== cwd) args.push('--add-dir', d);
    }

    return new Promise<unknown>((resolve, reject) => {
      // Разбор потока общий с живой сессией (_claude-stream.js): событие CLI одно и то
      // же, и вторая копия правил про usage, компакт и пустой ответ разошлась бы с первой.
      const collector = createClaudeTurnCollector({ onStep, onProgress, log });
      const { state } = collector;
      let buf = '';
      // Id сессии сообщаем с первого события, как и живая сессия: оборванный ход обязан
      // оставить чату сессию, а не только финальный result.
      let sessionAnnounced = false;

      // Своего таймаута у процесса НЕТ: лимит хода считает watchdog в modules/chat —
      // только он знает, что агент не работает, а ждёт ответа человека (это время не в счёт).
      // signal — и кнопка «стоп», и тот самый лимит: Node убивает процесс, мы отличаем
      // остановку по коду ошибки (ABORT_ERR) и возвращаем понятный текст, а не «код null».
      const child = execFile(config.claudeBin, args, { cwd, env, maxBuffer: 64 * 1024 * 1024, signal }, (err, stdout, stderr) => {
        // Подстраховка: финальная строка могла остаться в буфере без \n.
        if (!state.resultEv) {
          for (const line of (buf + '\n' + (stdout || '')).split('\n')) {
            const t = line.trim();
            if (!t.startsWith('{')) continue;
            try {
              const ev = JSON.parse(t) as { type?: string };
              if (ev.type === 'result') state.resultEv = ev;
            } catch { /* мусор */ }
          }
        }
        if (!state.resultEv) {
          if (err?.code === 'ABORT_ERR' || signal?.aborted) {
            return reject(Object.assign(new Error('Ход остановлен.'), {
              stopped: true,
              steps: collector.steps,
              // Сессия оборванного хода — живая: по ней продолжится следующий вопрос.
              sessionId: state.streamSessionId || sessionId || null,
              // Размер контекста у оборванного хода известен: его сообщил поток. Без него
              // кольцо после «стопа» показывало прежнюю (а у свежей сессии — нулевую) цифру,
              // и чат с реальными 80k выглядел пустым.
              contextTokens: state.lastTurnInput ?? 0,
              contextMetric: state.lastTurnInput === null ? 'unavailable' : 'active-input-v1',
              contextIsEstimate: false,
              contextCache: state.lastContextCache || contextCacheStatus('unavailable'),
            }));
          }
          if (err?.killed) return reject(new Error('Процесс агента убит извне (сигнал или переполнение буфера вывода).'));
          const tail = (stderr || '').trim().slice(-600);
          return reject(new Error(tail || `claude завершился без результата (код ${err?.code ?? '?'})`));
        }
        resolve(buildClaudeTurnResult(collector, { fallbackSessionId: sessionId, stderrTail: stderr, log }));
      });
      // stdin не используем — закрываем сразу, иначе claude ждёт ввода (3с warning, бывают зависания).
      child.stdin?.end();
      child.stdout?.on('data', (d: Buffer) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          let ev: unknown;
          try { ev = JSON.parse(line); } catch { continue; }
          collector.push(ev);
          if (!sessionAnnounced && state.streamSessionId && onSessionCreated) {
            sessionAnnounced = true;
            const known = state.streamSessionId;
            void Promise.resolve().then(() => onSessionCreated(known)).catch((error) => {
              log?.warn?.({ err: (error as Error)?.message }, 'чат: id сессии не принят вызывающим');
            });
          }
        }
      });
    });
  },

  /**
   * Живая сессия: тот же режим, в котором работает расширение VS Code
   * (`--input-format stream-json`). Процесс переживает свой ход, поэтому фоновые
   * команды и субагенты не гибнут вместе с ответом, а сам CLI будит модель, когда
   * они закончились — замер: ход закрыт на 9.1 с, непрошеный ответ пришёл на 21.4 с.
   *
   * Всё из restartOn — флаги командной строки, зафиксированные при запуске: сменить их
   * на лету нечем, поэтому пул переоткрывает сессию с прежним sessionId.
   */
  session: {
    mode: 'persistent',
    unsolicited: true,
    restartOn: [
      'model',
      'effort',
      'permissionMode',
      'cwd',
      'extraDirs',
      'providerSettings',
      'workToolScopeKey',
    ],

    open({
      config, env, cwd, extraDirs = [], model, effort, permissionMode, sessionId,
      mcpConfig, permissionPromptTool, providerSettings, log, hooks, workTools,
    }: {
      config: ClaudeConfig;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      extraDirs?: readonly string[];
      model?: string;
      effort?: string;
      permissionMode?: string;
      sessionId?: string | null;
      mcpConfig?: { mcpServers?: Record<string, unknown> } | null;
      permissionPromptTool?: string;
      providerSettings?: ClaudeSettings;
      log?: StreamLog;
      hooks?: Parameters<typeof openClaudeStreamSession>[0]['hooks'];
      workTools?: { descriptors?: unknown } | null;
    }) {
      return openClaudeStreamSession({
        bin: config.claudeBin,
        args: claudeSessionArgs({
          model,
          effort,
          permissionMode,
          sessionId,
          extraDirs,
          mcpConfig,
          permissionPromptTool,
          providerSettingsArgs: claudeProviderSettingsArgs(providerSettings),
          workTools,
        }),
        cwd,
        env,
        sessionId,
        log,
        hooks,
      });
    },
  },
};
