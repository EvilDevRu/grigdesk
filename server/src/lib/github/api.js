// Узкий REST-клиент GitHub для канала Issues. Он не знает ни accountRef, ни
// lifecycle канала: здесь только HTTP, строгие пределы ответа и безопасные ошибки.

const API_BASE = 'https://api.github.com';

export const GITHUB_API_VERSION = '2026-03-10';
export const GITHUB_API_RESPONSE_LIMIT = 32 * 1024 * 1024;
export const GITHUB_API_REQUEST_LIMIT = 64 * 1024;
export const GITHUB_LINK_HEADER_LIMIT = 16 * 1024;

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'cockpit-github-channel/1';

/** Ошибка GitHub REST без PAT и сырых тел ответа. */
export class GitHubApiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function maskToken(token) {
  const value = String(token ?? '').trim();
  if (!value) return '';
  return value.length <= 4 ? '…' : `…${value.slice(-4)}`;
}

/** Убирает PAT из любого provider/transport текста до лога или ответа API. */
export function scrubGitHubToken(text, token) {
  const value = String(token ?? '').trim();
  if (!value) return String(text ?? '');
  return String(text ?? '').split(value).join(maskToken(value));
}

function badInput(message) {
  throw new GitHubApiError('github_bad_input', message, { kind: 'github' });
}

function tokenOf(token) {
  const value = String(token ?? '').trim();
  if (!value || /[\u0000-\u0020\u007f]/u.test(value)) {
    badInput('GitHub PAT не задан или содержит недопустимые символы.');
  }
  return value;
}

function pathSegment(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text === '.' || text === '..') badInput(`Не задан ${label}.`);
  return encodeURIComponent(text);
}

function positiveDecimal(value, label) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text)) badInput(`${label} должен быть положительным целым.`);
  return text;
}

function positiveInt(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    badInput(`${label} должен быть целым от 1 до ${max}.`);
  }
  return value;
}

function callbackUrlOf(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    badInput('Callback URL GitHub webhook некорректен.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    badInput('Callback GitHub webhook должен быть HTTPS URL без credentials, query и fragment.');
  }
  return parsed.toString();
}

function secretOf(value) {
  if (typeof value !== 'string' || value.length < 16 || /[\u0000\r\n]/u.test(value)) {
    badInput('Webhook secret должен быть строкой не короче 16 символов.');
  }
  return value;
}

function repositoryPath(owner, repo) {
  return `/repos/${pathSegment(owner, 'owner')}/${pathSegment(repo, 'repository')}`;
}

function responseLimitOf(value) {
  if (!Number.isSafeInteger(value) || value < 1) badInput('Предел ответа GitHub некорректен.');
  return value;
}

function requestLimitOf(value) {
  if (!Number.isSafeInteger(value) || value < 1) badInput('Предел запроса GitHub некорректен.');
  return value;
}

async function readBoundedBody(response, limit) {
  const rawLength = response.headers?.get?.('content-length');
  if (rawLength !== null && rawLength !== undefined && rawLength !== '') {
    if (!/^\d+$/u.test(rawLength)) {
      throw new GitHubApiError(
        'github_invalid_response',
        'GitHub вернул некорректный Content-Length.',
        { kind: 'github', status: response.status },
      );
    }
    if (Number(rawLength) > limit) {
      throw new GitHubApiError(
        'github_response_too_large',
        `Ответ GitHub больше допустимых ${limit} байт.`,
        { kind: 'github', status: response.status, limit },
      );
    }
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) {
      throw new GitHubApiError(
        'github_response_too_large',
        `Ответ GitHub больше допустимых ${limit} байт.`,
        { kind: 'github', status: response.status, limit },
      );
    }
    return bytes;
  }

  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    length += chunk.length;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      throw new GitHubApiError(
        'github_response_too_large',
        `Ответ GitHub больше допустимых ${limit} байт.`,
        { kind: 'github', status: response.status, limit },
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function parsePayload(bytes, status) {
  if (!bytes.length) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new GitHubApiError(
      'github_invalid_response',
      'GitHub вернул невалидный JSON.',
      { kind: 'github', status },
    );
  }
}

function rejectedError(response, payload, token) {
  const providerMessage = typeof payload?.message === 'string' ? payload.message : '';
  const detail = scrubGitHubToken(providerMessage || `HTTP ${response.status}`, token);
  let code = 'github_rejected';
  if (response.status === 401 || response.status === 403) code = 'github_forbidden';
  if (response.status === 404) code = 'github_not_found';
  return new GitHubApiError(code, `GitHub отказал: ${detail}`, {
    kind: 'github',
    status: response.status,
    documentationUrl: typeof payload?.documentation_url === 'string'
      ? payload.documentation_url
      : null,
  });
}

async function requestGitHubApi(token, pathname, options = {}) {
  const {
    method = 'GET',
    body,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = GITHUB_API_RESPONSE_LIMIT,
    maxRequestBytes = GITHUB_API_REQUEST_LIMIT,
    expectedStatuses = [200],
  } = options;

  const pat = tokenOf(token);
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    badInput('GitHub API path должен быть относительным путём от api.github.com.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) badInput('Timeout GitHub некорректен.');
  const responseLimit = responseLimitOf(maxResponseBytes);
  const requestLimit = requestLimitOf(maxRequestBytes);
  if (!Array.isArray(expectedStatuses) || !expectedStatuses.every(Number.isInteger)) {
    badInput('Список ожидаемых HTTP-статусов GitHub некорректен.');
  }

  let encodedBody;
  if (body !== undefined) {
    try {
      encodedBody = JSON.stringify(body);
    } catch {
      badInput('Тело запроса GitHub не сериализуется в JSON.');
    }
    if (Buffer.byteLength(encodedBody) > requestLimit) {
      throw new GitHubApiError(
        'github_request_too_large',
        `Запрос GitHub больше допустимых ${requestLimit} байт.`,
        { kind: 'github', limit: requestLimit },
      );
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  let bytes;
  try {
    response = await fetchImpl(`${API_BASE}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${pat}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...(encodedBody === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: encodedBody,
    });
    bytes = await readBoundedBody(response, responseLimit);
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    const timedOut = controller.signal.aborted;
    const detail = timedOut
      ? `нет ответа за ${Math.ceil(timeoutMs / 1000)} с`
      : scrubGitHubToken(error?.message || error, pat);
    throw new GitHubApiError(
      timedOut ? 'github_timeout' : 'github_unreachable',
      timedOut ? `GitHub не ответил: ${detail}.` : `Не достучались до GitHub: ${detail}`,
      { kind: 'transport', causeCode: error?.code || (timedOut ? 'ABORT_ERR' : undefined) },
    );
  } finally {
    clearTimeout(timer);
  }

  const payload = parsePayload(bytes, response.status);
  if (!expectedStatuses.includes(response.status)) throw rejectedError(response, payload, pat);
  return { status: response.status, payload, headers: response.headers };
}

/** Низкоуровневый bounded REST-вызов; наружу отдаёт только JSON payload. */
export async function callGitHubApi(token, pathname, options = {}) {
  return (await requestGitHubApi(token, pathname, options)).payload;
}

function expectObject(payload, operation) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GitHubApiError(
      'github_invalid_response',
      `GitHub вернул неверную форму ответа для ${operation}.`,
      { kind: 'github' },
    );
  }
  return payload;
}

function expectArray(payload, operation) {
  if (!Array.isArray(payload)) {
    throw new GitHubApiError(
      'github_invalid_response',
      `GitHub вернул неверную форму ответа для ${operation}.`,
      { kind: 'github' },
    );
  }
  return payload;
}

/** Проверить repository и получить его provider identity (`id`). */
export async function getRepository(token, owner, repo, options = {}) {
  const payload = await callGitHubApi(token, repositoryPath(owner, repo), options);
  return expectObject(payload, 'repository');
}

/** Список hooks нужен для crash-reconciliation по точному callback URL. */
export async function listRepositoryHooks(token, owner, repo, options = {}) {
  const { page = 1, perPage = 100, ...requestOptions } = options || {};
  positiveInt(page, 'page', Number.MAX_SAFE_INTEGER);
  positiveInt(perPage, 'perPage', 100);
  const query = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  const payload = await callGitHubApi(
    token,
    `${repositoryPath(owner, repo)}/hooks?${query}`,
    requestOptions,
  );
  return expectArray(payload, 'repository hooks');
}

export async function getRepositoryHook(token, owner, repo, hookId, options = {}) {
  const payload = await callGitHubApi(
    token,
    `${repositoryPath(owner, repo)}/hooks/${positiveDecimal(hookId, 'hookId')}`,
    options,
  );
  return expectObject(payload, 'repository hook');
}

/** Создаёт намеренно неактивный hook; activation и ping выполняются отдельно. */
export async function createRepositoryHook(
  token,
  owner,
  repo,
  { url, secret, active = false } = {},
  options = {},
) {
  if (typeof active !== 'boolean') badInput('active должен быть boolean.');
  const payload = await callGitHubApi(token, `${repositoryPath(owner, repo)}/hooks`, {
    ...options,
    method: 'POST',
    expectedStatuses: [201],
    body: {
      name: 'web',
      active,
      events: ['issues'],
      config: {
        url: callbackUrlOf(url),
        content_type: 'json',
        insecure_ssl: '0',
        secret: secretOf(secret),
      },
    },
  });
  return expectObject(payload, 'create repository hook');
}

/** Меняет только наш hook и всегда сохраняет узкую подписку `issues`. */
export async function updateRepositoryHook(
  token,
  owner,
  repo,
  hookId,
  changes = {},
  options = {},
) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    badInput('Изменения GitHub hook должны быть объектом.');
  }
  const body = { events: ['issues'] };
  if (Object.hasOwn(changes, 'active')) {
    if (typeof changes.active !== 'boolean') badInput('active должен быть boolean.');
    body.active = changes.active;
  }
  const changesConfig = Object.hasOwn(changes, 'url') || Object.hasOwn(changes, 'secret');
  if (changesConfig) {
    body.config = {
      url: callbackUrlOf(changes.url),
      content_type: 'json',
      insecure_ssl: '0',
      secret: secretOf(changes.secret),
    };
  }
  const payload = await callGitHubApi(
    token,
    `${repositoryPath(owner, repo)}/hooks/${positiveDecimal(hookId, 'hookId')}`,
    { ...options, method: 'PATCH', body },
  );
  return expectObject(payload, 'update repository hook');
}

export async function pingRepositoryHook(token, owner, repo, hookId, options = {}) {
  await requestGitHubApi(
    token,
    `${repositoryPath(owner, repo)}/hooks/${positiveDecimal(hookId, 'hookId')}/pings`,
    { ...options, method: 'POST', expectedStatuses: [204] },
  );
}

/** 404 идемпотентно означает, что удалять уже нечего. */
export async function deleteRepositoryHook(token, owner, repo, hookId, options = {}) {
  const result = await requestGitHubApi(
    token,
    `${repositoryPath(owner, repo)}/hooks/${positiveDecimal(hookId, 'hookId')}`,
    { ...options, method: 'DELETE', expectedStatuses: [204, 404] },
  );
  return { deleted: result.status === 204, missing: result.status === 404 };
}

function githubLinkPath(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new GitHubApiError(
      'github_link_invalid',
      'GitHub вернул некорректный URL в Link header.',
      { kind: 'github' },
    );
  }
  if (parsed.origin !== API_BASE || parsed.username || parsed.password || parsed.hash) {
    throw new GitHubApiError(
      'github_link_invalid',
      'GitHub Link header ведёт не на доверенный api.github.com.',
      { kind: 'github' },
    );
  }
  return `${parsed.pathname}${parsed.search}`;
}

/** Строго разбирает стандартный pagination Link и возвращает exact `rel=next` path. */
function nextPathFromLink(headers) {
  const raw = headers?.get?.('link');
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > GITHUB_LINK_HEADER_LIMIT) {
    throw new GitHubApiError(
      'github_link_invalid',
      'GitHub вернул пустой или слишком большой Link header.',
      { kind: 'github' },
    );
  }

  const links = new Map();
  for (const part of raw.split(',')) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel="(next|prev|first|last)"\s*$/u.exec(part);
    if (!match || links.has(match[2])) {
      throw new GitHubApiError(
        'github_link_invalid',
        'GitHub вернул неоднозначный или некорректный Link header.',
        { kind: 'github' },
      );
    }
    links.set(match[2], githubLinkPath(match[1]));
  }
  return links.get('next') || null;
}

function issuesPagePath(owner, repo, { page, perPage, nextPath }) {
  if (nextPath !== undefined && nextPath !== null) {
    if (typeof nextPath !== 'string' || !nextPath.startsWith('/') || nextPath.startsWith('//')) {
      badInput('nextPath GitHub issues некорректен.');
    }
    const parsed = new URL(nextPath, API_BASE);
    if (parsed.origin !== API_BASE || parsed.hash) badInput('nextPath GitHub issues недоверенный.');
    const initialPath = `${repositoryPath(owner, repo)}/issues`;
    const canonicalRepositoryPath = /^\/repositories\/[1-9]\d*\/issues$/u;
    if (parsed.pathname !== initialPath && !canonicalRepositoryPath.test(parsed.pathname)) {
      badInput('nextPath ведёт не на страницу repository issues.');
    }
    return `${parsed.pathname}${parsed.search}`;
  }

  positiveInt(page, 'page', Number.MAX_SAFE_INTEGER);
  positiveInt(perPage, 'perPage', 100);
  const query = new URLSearchParams({
    state: 'all',
    sort: 'created',
    direction: 'desc',
    per_page: String(perPage),
    page: String(page),
  });
  return `${repositoryPath(owner, repo)}/issues?${query}`;
}

/**
 * Одна exact-страница reconciliation. Следующий путь берётся из provider Link,
 * а не угадывается как `page + 1`; полный foreign URL наружу не возвращается.
 */
export async function listRepositoryIssuesPage(token, owner, repo, options = {}) {
  const {
    page = 1,
    perPage = 100,
    nextPath,
    ...requestOptions
  } = options || {};
  const path = issuesPagePath(owner, repo, { page, perPage, nextPath });
  const result = await requestGitHubApi(token, path, requestOptions);
  return {
    issues: expectArray(result.payload, 'repository issues'),
    nextPath: nextPathFromLink(result.headers),
  };
}

/**
 * Страница reconciliation: сортировка только по created, `since` намеренно нет —
 * GitHub трактует его как updated_at. Pull requests фильтрует вызывающий adapter.
 */
export async function listRepositoryIssues(token, owner, repo, options = {}) {
  return (await listRepositoryIssuesPage(token, owner, repo, options)).issues;
}
