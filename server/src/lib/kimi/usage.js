// Read-only статистика подписки Kimi. Сам Cockpit не открывает OAuth credentials:
// официальный `kimi web` кратковременно выступает credential broker и отдаёт
// типизированный `/api/v1/oauth/usage`. Model session/turn при этом не создаётся.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;
const EXIT_TIMEOUT_MS = 2_000;
const MAX_PROCESS_OUTPUT = 64 * 1024;
const KIMI_CONSOLE = 'https://www.kimi.com/code/console';

function waitForExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    child.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function usageBrokerEnv(config) {
  const binDir = path.dirname(config.kimiBin);
  // Native binary распаковывает встроенные web-assets перед стартом API. Держим
  // этот технический кэш в runtime-каталоге Cockpit: systemd unit может не иметь
  // права писать в host ~/.cache, а OAuth home Kimi остаётся отдельным read-only
  // источником для самого CLI.
  const cacheDir = path.join(config.kimiRuntimeHome || config.kimiHome, 'usage-cache');
  return {
    HOME: path.dirname(config.kimiHome),
    KIMI_CODE_HOME: config.kimiHome,
    KIMI_CODE_CACHE_DIR: cacheDir,
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    NO_COLOR: '1',
    PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
  };
}

function parseReadyUrl(output) {
  // При `--log-level silent` Kimi 0.31.1 печатает не компактную строку
  // `Kimi server: ...`, а многострочный баннер `Kimi server ready` с URL в
  // строке `Local:`. Привязываться к декоративному тексту нельзя: извлекаем URL,
  // а затем независимо проверяем loopback, порт и token fragment.
  const plain = String(output || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const href = plain.match(/http:\/\/127\.0\.0\.1:\d+\/?#token=[^\s]+/)?.[0];
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.hostname !== '127.0.0.1' || !url.port || !url.hash.startsWith('#token=')) return null;
    const token = decodeURIComponent(url.hash.slice('#token='.length));
    if (!token) return null;
    url.hash = '';
    return { origin: url.href.replace(/\/$/, ''), token };
  } catch {
    return null;
  }
}

/**
 * Поднимает официальный loopback-only Kimi server на auto-selected port,
 * делает один usage GET и штатно закрывает именно этот child. Bearer token
 * остаётся внутри функции и никогда не попадает в return/log.
 */
export async function requestKimiManagedUsage(config, {
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
} = {}) {
  // `kimi web` индексирует cwd как workspace ещё до ready-banner. Если запускать
  // его из корня Cockpit, read-only проверка лимитов превращается в долгий обход
  // всего репозитория и не укладывается в startup timeout.
  const workDir = path.join(config.kimiRuntimeHome || config.rootDir, 'usage-work');
  try {
    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      reason: 'workspace_prepare_failed',
      error: error?.message || 'Не удалось подготовить Kimi usage workspace',
    };
  }
  let child;
  try {
    child = spawnProcess(config.kimiBin, [
      'web', '--host', '127.0.0.1', '--port', '0', '--no-open', '--log-level', 'silent',
    ], {
      cwd: workDir,
      env: usageBrokerEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      reason: 'spawn_failed',
      error: error?.message || 'Kimi usage broker не запустился',
    };
  }

  let stdout = '';
  let stderr = '';
  let ready = null;
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  const timer = setTimeout(() => resolveReady(null), START_TIMEOUT_MS);
  timer.unref?.();

  child.stdout?.on('data', (chunk) => {
    stdout = `${stdout}${String(chunk || '')}`.slice(-MAX_PROCESS_OUTPUT);
    ready ||= parseReadyUrl(stdout);
    if (ready) resolveReady(ready);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk || '')}`.slice(-MAX_PROCESS_OUTPUT);
  });
  child.once('error', () => resolveReady(null));
  child.once('close', () => resolveReady(null));

  try {
    ready = await readyPromise;
    clearTimeout(timer);
    if (!ready) {
      return {
        reason: 'startup_timeout',
        error: stderr.trim().slice(-500) || 'Kimi usage broker не поднялся за отведённое время',
      };
    }
    let response;
    try {
      response = await fetchImpl(
        `${ready.origin}/api/v1/oauth/usage?provider=managed%3Akimi-code`,
        {
          headers: { Authorization: `Bearer ${ready.token}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      return {
        reason: 'request_failed',
        error: error?.message || 'Kimi usage broker недоступен',
      };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        reason: 'response_rejected',
        status: response.status,
        error: 'Kimi usage broker отклонил запрос',
      };
    }
    return { result: body?.data ?? null };
  } finally {
    clearTimeout(timer);
    if (ready) {
      await fetchImpl(`${ready.origin}/api/v1/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ready.token}` },
        signal: AbortSignal.timeout(1_500),
      }).catch(() => null);
    }
    if (!(await waitForExit(child))) {
      child.kill('SIGTERM');
      if (!(await waitForExit(child))) child.kill('SIGKILL');
    }
  }
}

/**
 * Имя лимита от сервиса ПРИКЛЕИВАЕТСЯ к подписи окна, а не заменяет её и не проигрывает
 * ей. Узнаваемое окно проверялось первым, поэтому два именованных недельных лимита
 * отрисовывались двумя одинаковыми строками «Неделя (7д)» — различить их было нечем.
 * Приём тот же, что у Codex с `limitName`: «Неделя · gpt-reserve».
 *
 * У известных окон длительность в скобках дублирует само слово, поэтому уходит; у
 * вычисленного «Окно (3д)» она и есть весь смысл подписи и остаётся.
 */
function windowLabel(window, name = '') {
  const duration = Number(window?.duration);
  const unit = String(window?.unit || '');
  const suffix = { minute: 'м', hour: 'ч', day: 'д', week: 'нед' }[unit] || unit;
  const named = String(name || '').trim();

  let base = '';
  let short = '';

  if (duration === 5 && unit === 'hour') {
    base = 'Сессия (5ч)';
    short = 'Сессия';
  } else if (duration === 1 && unit === 'week') {
    base = 'Неделя (7д)';
    short = 'Неделя';
  } else if (duration > 0 && suffix) {
    base = `Окно (${duration}${suffix})`;
    short = base;
  }

  if (!named) {
    return base || 'Лимит';
  }

  return short ? `${short} · ${named}` : named;
}

function resetIso(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * Полосы приходят массивом (`summary` плюс `limits`), поэтому порядок сервиса стабилен
 * и своей сортировки не требует — в отличие от Codex, где вёдра лежат в объекте.
 *
 * Ведро называет поле `group`: безымянные окна — это одна подписка (сессия и неделя
 * одного счёта), а именованный лимит живёт своей квотой. По нему всплывашка ставит
 * разделитель и метку «новое», не зная про Kimi ничего.
 */
export function parseKimiUsageBars(result) {
  if (!result || result.kind !== 'ok') return [];
  const rows = [result.summary, ...(Array.isArray(result.limits) ? result.limits : [])].filter(Boolean);
  return rows.flatMap((row, index) => {
    const used = Number(row.used);
    const limit = Number(row.limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return [];
    const window = row.window || {};
    const named = String(row.name || '').trim();
    return [{
      key: `kimi:${index}:${window.duration || 0}:${window.unit || 'limit'}`,
      group: named ? `named:${named}` : 'subscription',
      label: windowLabel(window, named),
      pct: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
      resetsAt: resetIso(row.reset_at),
    }];
  });
}

function money(cents, currency) {
  const amount = (Number(cents) / 100).toFixed(2);
  if (String(currency).toUpperCase() === 'CNY') return `¥${amount}`;
  if (String(currency).toUpperCase() === 'USD') return `$${amount}`;
  return `${amount} ${currency || ''}`.trim();
}

export function parseKimiUsageResources(result) {
  const extra = result?.kind === 'ok' ? result.extra_usage : null;
  if (!extra || typeof extra !== 'object') return [];
  const currency = String(extra.currency || 'CNY');
  const used = Number(extra.monthly_used_cents) || 0;
  const limit = Number(extra.monthly_charge_limit_cents) || 0;
  const limited = extra.monthly_charge_limit_enabled === true && limit > 0;
  return [{
    key: 'kimi-extra-usage',
    label: 'Extra Usage',
    summary: `Баланс: ${money(Number(extra.balance_cents) || 0, currency)}`,
    tone: Number(extra.balance_cents) > 0 ? 'ok' : 'muted',
    ...(limited && { percent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))) }),
    note: limited
      ? `В этом месяце: ${money(used, currency)} из ${money(limit, currency)}.`
      : `В этом месяце: ${money(used, currency)}; месячный потолок не задан.`,
    controls: [{
      id: 'manage-kimi-usage',
      kind: 'link',
      label: 'Лимиты и пополнение в Kimi',
      href: KIMI_CONSOLE,
    }],
  }];
}

/**
 * Стоит ли повторять эту неудачу. У Kimi повтор дороже, чем у соседей: каждая попытка
 * заново поднимает локальный брокер, поэтому право на него выдано узко.
 *
 * Повторяем только там, где брокер УЖЕ поднялся, а споткнулся сам запрос: `request_failed`
 * и серверные 5xx. Тогда и второй старт, скорее всего, пройдёт быстро.
 *
 * Не повторяем:
 * - `startup_timeout` — он уже съел свои 30 секунд, вторая попытка съест столько же, пока
 *   человек смотрит на пустую шапку;
 * - `spawn_failed`, `workspace_prepare_failed` — это локальная поломка, а не сеть;
 * - 401/402/403 — отказ аккаунта, и 429 тоже: ограничение снимут не через секунду,
 *   а повтор в моменте только усугубит его.
 */
export function kimiUsageIsRetryable({ result = null, status = 0, reason = '' } = {}) {
  if (result?.kind === 'ok') return false;
  if (result?.kind === 'error') return (Number(result.status) || 0) >= 500;
  if (reason === 'request_failed') return true;
  if (reason === 'response_rejected') return (Number(status) || 0) >= 500;
  return false;
}

export function classifyKimiUsageResponse({ result = null, error = '', status = 0, reason = '' } = {}) {
  const login = { kind: 'terminal', label: 'Войти в Kimi', command: 'kimi login' };
  if (result?.kind === 'error') {
    const detail = String(result.message || '').slice(0, 500);
    const code = Number(result.status) || 0;
    if (code === 401 || /authori[sz]|login|credential/i.test(detail)) {
      return { state: 'auth_required', bars: [], message: 'Авторизация Kimi истекла. Выполни kimi login.', detail, action: login };
    }
    if (code === 429) return { state: 'rate_limited', bars: [], message: 'Kimi временно ограничил проверку лимитов.', detail, action: null };
    if (code === 402 || code === 403) return { state: 'blocked', bars: [], message: 'Kimi не подтвердил подписку или доступ к квоте.', detail, action: null };
    return { state: 'unavailable', bars: [], message: 'Не удалось получить лимиты Kimi.', detail, action: null };
  }
  if (result?.kind === 'ok') {
    const bars = parseKimiUsageBars(result);
    const resources = parseKimiUsageResources(result);
    if (bars.length || resources.length) return { state: 'ok', bars, resources, message: '', action: null };
    return { state: 'unavailable', bars: [], resources: [], message: 'Kimi не вернул данные о лимитах.', action: null };
  }
  if (status === 401) return { state: 'auth_required', bars: [], message: 'Авторизация Kimi недействительна.', action: login };
  const failureMessage = {
    workspace_prepare_failed: 'Cockpit не смог подготовить каталог проверки лимитов Kimi.',
    spawn_failed: 'Cockpit не смог запустить локальную проверку лимитов Kimi.',
    startup_timeout: 'Локальный сервер проверки лимитов Kimi не успел запуститься.',
    request_failed: 'Локальный сервер Kimi запустился, но не ответил на запрос лимитов.',
    response_rejected: 'Kimi отклонил запрос данных о лимитах.',
  }[reason];
  return {
    state: 'unavailable',
    bars: [],
    message: failureMessage || 'Не удалось получить лимиты Kimi. Повторим проверку автоматически.',
    detail: String(error || '').slice(0, 500),
    action: null,
  };
}

export { parseReadyUrl, usageBrokerEnv };
