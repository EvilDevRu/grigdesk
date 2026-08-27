// Исполнитель GPT (OpenAI Codex CLI).
// Установка: npm i -g @openai/codex && codex login — после этого провайдер оживает сам.
// Ходы идут через `codex app-server`: новый разговор делает `thread/start`, следующий
// `thread/resume`, затем `turn/start`. Песочница workspace-write: текущий cwd и явно
// доверенные каталоги доступны для правок, сеть включена для gh/git/package CLI,
// остальная файловая система закрыта.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { npmLatest } from './_npm-latest.js';
import { withRetry } from '../retry.js';
import { createStepSink } from '../chat/stream-steps.js';
import { contextCacheStatus, reportedContextCache } from '../chat/context-cache.js';
import { createCodexStepNormalizer } from './_codex-steps.js';
import {
  DIRECT_SSH_HOOK_COMMAND,
  DIRECT_SSH_HOOK_MATCHER,
  directSshSetting,
} from './_direct-ssh-policy.js';

const APP_SERVER_TIMEOUT_MS = 15_000;

function windowLabel(minutes) {
  if (minutes === 300) return 'Сессия (5ч)';
  if (minutes === 10_080) return 'Неделя (7д)';
  if (Number.isFinite(minutes) && minutes > 0 && minutes % 1_440 === 0) {
    return `Окно (${minutes / 1_440}д)`;
  }
  if (Number.isFinite(minutes) && minutes > 0 && minutes % 60 === 0) {
    return `Окно (${minutes / 60}ч)`;
  }
  return Number.isFinite(minutes) && minutes > 0 ? `Окно (${minutes}м)` : 'Лимит';
}

function resetIso(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Общая квота аккаунта (ведро без собственного имени) всегда идёт первой: в неё
 * упираются раньше всего. Остальные сортируются по ВИДИМОЙ подписи, а не по
 * внутреннему id: по id `base_model_inference` встал бы впереди `codex`, хотя
 * человек читает «gpt-reserve» и «Неделя (7д)». Одинаковые подписи разводит id,
 * чтобы порядок оставался полным.
 */
function compareCodexBuckets(a, b) {
  const generalA = a.scope === '';
  const generalB = b.scope === '';

  if (generalA !== generalB) {
    return generalA ? -1 : 1;
  }

  return a.scope.localeCompare(b.scope, 'ru') || a.id.localeCompare(b.id);
}

/**
 * Слоты окна нельзя перечислять списком: `['primary', 'secondary']` — это снимок
 * СЕГОДНЯШНЕЙ схемы, и третий слот выпал бы молча, как выпадало бы новое ведро при
 * allowlist по id. Берём любое поле ведра, которое выглядит окном (числовой
 * `usedPercent`); `credits` и `individualLimit` под это не подходят — у первого
 * процента нет вовсе, у второго он называется `remainingPercent`.
 *
 * Порядок — от короткого окна к длинному (сессия перед неделей), а не по имени поля:
 * имена придумывает сервис, смысл несёт длительность. Ведро без длительности уходит
 * в конец, одинаковые разводит имя слота — иначе сортировка была бы неполной.
 */
function bucketWindows(bucket) {
  const windows = Object.entries(bucket)
    .filter(([, window]) => window && typeof window.usedPercent === 'number')
    .map(([slot, window]) => ({ slot, window }));

  return windows.sort((a, b) => {
    const left = Number.isFinite(a.window.windowDurationMins) ? a.window.windowDurationMins : Infinity;
    const right = Number.isFinite(b.window.windowDurationMins) ? b.window.windowDurationMins : Infinity;

    if (left !== right) {
      return left < right ? -1 : 1;
    }

    return a.slot.localeCompare(b.slot);
  });
}

/**
 * Контракт app-server: account/rateLimits/read. `rateLimitsByLimitId` — текущий
 * многовёдерный вид, `rateLimits` остаётся совместимым запасным. Имена вёдер
 * приходят от сервиса, поэтому новое семейство Codex появляется в шапке без
 * релиза кокпита.
 *
 * Порядок полос принадлежит кокпиту, а не сервису: `rateLimitsByLimitId` — объект,
 * и OpenAI отдаёт ключи в разном порядке на каждый ответ (замер: шесть запросов
 * подряд — три разных порядка). Минутное обновление шапки поэтому перетасовывало
 * полосы прямо под курсором. Поле `group` называет ведро, которому принадлежит
 * полоса: по нему всплывашка ставит разделитель, не зная про вендора.
 */
export function parseCodexRateLimits(result) {
  const byId = result?.rateLimitsByLimitId;
  const source = byId && typeof byId === 'object' && Object.keys(byId).length
    ? Object.values(byId)
    : (result?.rateLimits ? [result.rateLimits] : []);
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

  const buckets = [];

  for (const bucket of source) {
    if (!bucket || typeof bucket !== 'object') {
      continue;
    }

    const id = String(bucket.limitId || 'codex');
    buckets.push({
      id,
      bucket,
      scope: bucket.limitName || (id !== 'codex' ? id : ''),
    });
  }

  buckets.sort(compareCodexBuckets);

  const bars = [];

  for (const { id, bucket, scope } of buckets) {
    for (const { slot, window } of bucketWindows(bucket)) {
      const base = windowLabel(window.windowDurationMins);
      bars.push({
        key: `${id}:${slot}`,
        group: id,
        label: scope ? `${base.replace(/ \([^)]+\)$/, '')} · ${scope}` : base,
        pct: clamp(window.usedPercent),
        resetsAt: resetIso(window.resetsAt),
      });
    }
  }

  return bars;
}

// Почему аккаунт упёрся, сервис называет поимённо. Свои формулировки нужны потому,
// что коды приходят по сети и человеку ничего не говорят; незнакомый код показывается
// как есть — выдумывать за сервис перевод хуже, чем показать его слово.
const CODEX_REACHED_REASON = {
  rate_limit_reached: 'достигнут лимит запросов',
  workspace_owner_credits_depleted: 'кончились кредиты владельца рабочей области',
  workspace_member_credits_depleted: 'кончились кредиты участника рабочей области',
  workspace_owner_usage_limit_reached: 'достигнут лимит расхода владельца рабочей области',
  workspace_member_usage_limit_reached: 'достигнут лимит расхода участника рабочей области',
};

/**
 * Отдельный ресурс про КОНТРОЛЬ ТРАТ, а не про окна лимитов: `individualLimit` — это
 * персональный денежный потолок, а `spendControlReached` — упёрлись ли в него. Оба поля
 * приходили в ответе с самого начала и не показывались нигде, поэтому исчерпанный
 * потолок выглядел как «всё молча встало» без единой подсказки во всплывашке.
 *
 * Ресурса нет, пока сервис молчит: `null`/`false` — это «нечего сказать», и пустая
 * строка в шапке была бы шумом. Суммы остаются СТРОКАМИ как пришли: это деньги, и
 * `Number` на них молча теряет точность.
 */
function codexSpendControl(result, buckets) {
  const limit = buckets.map((bucket) => bucket.individualLimit)
    .find((value) => value && typeof value === 'object');
  const reached = buckets.some((bucket) => bucket.spendControlReached === true);
  const reason = buckets.map((bucket) => bucket.rateLimitReachedType)
    .find((value) => typeof value === 'string' && value);

  if (!limit && !reached && !reason) {
    return null;
  }

  const remaining = Number(limit?.remainingPercent);
  const notes = [];

  if (reached) {
    notes.push('Лимит трат исчерпан — ходы не пойдут до сброса.');
  }

  if (reason) {
    notes.push(`Причина от сервиса: ${CODEX_REACHED_REASON[reason] || reason}.`);
  }

  return {
    key: 'spend-control',
    label: 'Контроль трат',
    summary: limit ? `${limit.used} из ${limit.limit}` : (reached ? 'исчерпан' : 'достигнут лимит'),
    tone: reached ? 'bad' : 'muted',
    ...(Number.isFinite(remaining) && { percent: Math.max(0, Math.min(100, Math.round(100 - remaining))) }),
    ...(notes.length && { note: notes.join(' ') }),
  };
}

export function parseCodexUsageResources(result) {
  if (!result || typeof result !== 'object') return [];
  const buckets = [
    result.rateLimits,
    ...Object.values(result.rateLimitsByLimitId || {}),
  ].filter((bucket) => bucket && typeof bucket === 'object');
  const creditState = [result.credits, ...buckets.map((bucket) => bucket.credits)]
    .find((credits) => credits && typeof credits === 'object');
  const resources = [];

  // Первым: он один отвечает на «почему всё встало», остальные — справка о балансе.
  const spendControl = codexSpendControl(result, buckets);

  if (spendControl) {
    resources.push(spendControl);
  }

  if (creditState) {
    const balance = creditState.balance;
    const summary = creditState.unlimited
      ? 'Без ограничений'
      : `Баланс: ${balance ?? (creditState.hasCredits ? 'доступен' : '0')}`;
    resources.push({
      key: 'chatgpt-credits',
      label: 'Дополнительные кредиты',
      summary,
      tone: creditState.unlimited || creditState.hasCredits ? 'ok' : 'muted',
      note: 'Покупка и автопополнение управляются в ChatGPT.',
      controls: [{
        id: 'manage-credits',
        kind: 'link',
        label: 'Купить / управлять кредитами',
        href: 'https://chatgpt.com/codex/settings/usage',
      }],
    });
  }

  const resetState = result.rateLimitResetCredits;
  const count = Number(resetState?.availableCount);
  if (Number.isFinite(count) && count > 0) {
    const first = Array.isArray(resetState.credits)
      ? resetState.credits.find((credit) => credit?.status === 'available' && credit.id)
      : null;
    resources.push({
      key: 'rate-limit-resets',
      label: 'Сброс лимита',
      summary: `Доступно: ${Math.floor(count)}`,
      tone: 'ok',
      note: first?.description || 'Сбрасывает подходящее окно лимита и расходует один заработанный сброс.',
      controls: [{
        id: 'consume-rate-limit-reset',
        kind: 'button',
        label: 'Использовать сброс лимита',
        action: 'consume-rate-limit-reset',
        ...(first?.id && { payload: { creditId: String(first.id) } }),
        confirm: {
          text: 'Использовать один заработанный сброс лимита Codex? Отменить расход после подтверждения OpenAI нельзя.',
          label: 'Использовать',
          danger: true,
        },
      }],
    });
  }

  return resources;
}

// Два класса отказа, которые ожиданием не лечатся: устаревший CLI без метода и
// неавторизованный аккаунт. Всё остальное — сеть или занятый app-server, и повтор
// имеет смысл. Правило одно на классификатор и на ретрай: разъехавшись, они дали бы
// либо бессмысленные повторы на «нужен login», либо отсутствие повтора там, где он лечит.
const CODEX_USAGE_UNSUPPORTED_RE = /method not found/i;
const CODEX_USAGE_AUTH_RE = /login|required|sign.?in|unauthori[sz]ed|not authenticated|401/i;

export function codexUsageErrorIsPermanent(error) {
  if (!error) return false;
  const detail = String(error?.message || error || '').slice(0, 500);
  return error?.code === -32601
    || CODEX_USAGE_UNSUPPORTED_RE.test(detail)
    || CODEX_USAGE_AUTH_RE.test(detail);
}

export function classifyCodexUsageResponse({ result = null, error = null } = {}) {
  const detail = String(error?.message || error || '').slice(0, 500);
  if (error) {
    if (error?.code === -32601 || CODEX_USAGE_UNSUPPORTED_RE.test(detail)) {
      return {
        state: 'unsupported',
        bars: [],
        message: 'Установленная версия Codex не умеет отдавать лимиты. Обнови CLI в настройках.',
        detail,
        action: null,
      };
    }
    if (CODEX_USAGE_AUTH_RE.test(detail)) {
      return {
        state: 'auth_required',
        bars: [],
        message: 'Codex CLI не авторизован или сессия истекла. Выполни codex login.',
        detail,
        action: { kind: 'terminal', label: 'Войти в Codex', command: 'codex login' },
      };
    }
    return {
      state: 'unavailable',
      bars: [],
      message: 'Не удалось получить лимиты Codex. Повторим проверку автоматически.',
      detail,
      action: null,
    };
  }

  const bars = parseCodexRateLimits(result);
  const resources = parseCodexUsageResources(result);
  if (!bars.length && !resources.length) {
    return {
      state: 'unavailable',
      bars: [],
      resources: [],
      message: 'OpenAI не вернул данные о лимитах Codex.',
      action: null,
    };
  }
  return { state: 'ok', bars, resources, message: '', action: null };
}

/**
 * Каталог для модельного селектора из документированного `model/list`.
 * `model` — канонический slug, `id` может быть его алиасом. Алиасы схлопываем,
 * чтобы одна и та же модель не появлялась в интерфейсе дважды.
 */
export function codexModelFamily(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  const match = /^gpt-(?:\d+(?:\.\d+)*|next)-([a-z][a-z0-9-]*)$/.exec(id);
  return match?.[1] || '';
}

/**
 * `model/list` не обещает размер окна. Старый app-server мог прислать расширенное
 * поле, и его сохраняем, но отсутствие нельзя подменять паспортным окном API:
 * рабочий потолок Codex зависит от thread и точно приезжает только с token usage.
 */
function codexCatalogContext(entry) {
  const context = Number(entry?.contextWindow);

  if (Number.isSafeInteger(context) && context > 0) {
    return { context };
  }

  return {
    context: 0,
    contextUnverified: true,
    contextRuntimeOnly: true,
  };
}

export function parseCodexModelList(result) {
  if (!Array.isArray(result?.data) || !result.data.length) return null;

  const entries = result.data
    .filter((entry) => entry && typeof entry === 'object' && (entry.model || entry.id));
  const canonicalByName = new Map(entries
    .filter((entry) => entry.id === entry.model && !/^codex-/i.test(entry.id || ''))
    .map((entry) => [String(entry.displayName || '').trim().toLowerCase(), entry.model]));
  const groups = new Map();
  entries.forEach((entry, index) => {
    const slug = String(entry.model || entry.id).trim();
    const name = String(entry.displayName || '').trim().toLowerCase();
    // Некоторые rollout-алиасы (`codex-auto-review`) приходят отдельной строкой с
    // собственным slug, но теми же displayName/возможностями, что канонический GPT.
    const canonical = /^codex-/i.test(slug) && canonicalByName.get(name)
      ? canonicalByName.get(name)
      : slug;
    if (!groups.has(canonical)) groups.set(canonical, { index, entries: [] });
    groups.get(canonical).entries.push(entry);
  });

  const models = [];
  for (const group of groups.values()) {
    const exact = group.entries.find((entry) => entry.id === entry.model && !/^codex-/i.test(entry.id || ''))
      || group.entries[0];
    const id = String(exact.model || exact.id);
    const family = codexModelFamily(id);
    const effortSource = group.entries
      .map((entry) => entry.supportedReasoningEfforts)
      .find((efforts) => Array.isArray(efforts) && efforts.length) || [];
    const efforts = [...new Set(effortSource
      .map((effort) => effort?.reasoningEffort)
      .filter((effort) => typeof effort === 'string' && effort))];
    const aliases = [...new Set(group.entries
      .flatMap((entry) => [entry.id, entry.model])
      .filter((alias) => alias && alias !== id))];
    const upgrade = exact.upgrade
      || group.entries.find((entry) => entry.upgrade)?.upgrade
      || null;

    models.push({
      id,
      ...(family && { family }),
      name: exact.displayName || id,
      ...codexCatalogContext(exact),
      tier: 10_000 - group.index,
      efforts: efforts.length ? efforts : null,
      defaultEffort: exact.defaultReasoningEffort || null,
      description: exact.description || '',
      inputModalities: Array.isArray(exact.inputModalities) ? exact.inputModalities : ['text', 'image'],
      isDefault: group.entries.some((entry) => entry.isDefault === true),
      // hidden — не входит в официальный picker; upgrade — оставлен только для миграции.
      // Оба доступны по общему флажку «Показывать все модели».
      extra: group.entries.every((entry) => entry.hidden === true) || !!upgrade,
      upgrade,
      ...(aliases.length && { aliases }),
    });
  }
  return models.sort((a, b) => b.tier - a.tier);
}

/**
 * `codex exec --json` кладёт в `turn.completed.usage` НАКОПЛЕННЫЙ расход thread:
 * каждый вызов модели после tool-call ещё раз добавляет весь вход. Это полезная
 * метрика работы/лимита, но не заполненность context window — в долгом ходе она
 * закономерно вырастает до миллионов при окне в сотни тысяч.
 *
 * cached_input_tokens уже входит в input_tokens, повторно его не складываем.
 */
export function codexTotalInputTokens(usage) {
  const tokens = Number(usage?.input_tokens);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
}

const CODEX_CONTEXT_METRIC = 'active-input-v1';
const ROLLOUT_READ_CHUNK = 256 * 1024;

function tokenNumber(value, { positive = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (positive && number <= 0)) return null;
  return number;
}

/**
 * Rollout пишет точную пару, которую показывает родной `/status`:
 * last_token_usage.input_tokens — вход ПОСЛЕДНЕГО model request (активный контекст),
 * model_context_window — эффективное окно уже с поправкой модели. total_token_usage
 * оставляем отдельной метрикой, чтобы не смешивать расход и заполненность.
 */
export function parseCodexTokenInfoLine(line) {
  let event;
  try { event = JSON.parse(String(line || '')); } catch { return null; }
  if (event?.payload?.type !== 'token_count') return null;
  const info = event.payload.info;
  const contextTokens = tokenNumber(info?.last_token_usage?.input_tokens);
  const cachedRequestTokens = tokenNumber(info?.last_token_usage?.cached_input_tokens);
  const contextWindow = tokenNumber(info?.model_context_window, { positive: true });
  if (contextTokens === null || contextWindow === null) return null;
  return {
    contextTokens,
    contextWindow,
    contextMetric: CODEX_CONTEXT_METRIC,
    contextIsEstimate: false,
    contextCache: cachedRequestTokens === null
      ? contextCacheStatus('unavailable')
      : reportedContextCache({
        readTokens: cachedRequestTokens,
        uncachedTokens: contextTokens - cachedRequestTokens,
      }),
    totalInputTokens: tokenNumber(info?.total_token_usage?.input_tokens) || 0,
    cachedInputTokens: tokenNumber(info?.total_token_usage?.cached_input_tokens) || 0,
  };
}

/** Читает rollout с конца: многомиллионный ход не грузим целиком в память. */
export async function readLatestCodexTokenInfo(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let position = size;
    let carry = '';
    while (position > 0) {
      const length = Math.min(ROLLOUT_READ_CHUNK, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const lines = `${chunk.subarray(0, bytesRead).toString('utf8')}${carry}`.split('\n');
      carry = position > 0 ? (lines.shift() || '') : '';
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const info = parseCodexTokenInfoLine(lines[i]);
        if (info) return info;
      }
    }
    return parseCodexTokenInfoLine(carry);
  } finally {
    await handle.close();
  }
}

function codexThreadDays(threadId) {
  const compact = String(threadId || '').replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  const timestamp = Number.parseInt(compact.slice(0, 12), 16);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  // Rollout-каталог использует календарный день хоста, UUIDv7 — UTC timestamp.
  // Вокруг полуночи они могут отличаться на сутки, поэтому проверяем соседние даты.
  return [-86_400_000, 0, 86_400_000]
    .map((shift) => new Date(timestamp + shift).toISOString().slice(0, 10).split('-'));
}

async function matchingRollout(dir, threadId) {
  try {
    const suffix = `-${threadId}.jsonl`;
    const names = await fs.readdir(dir);
    const name = names.find((candidate) => candidate.endsWith(suffix));
    return name ? path.join(dir, name) : null;
  } catch {
    return null;
  }
}

/** Находит только собственный UUID-файл thread; произвольный путь сюда не принимается. */
export async function readCodexThreadTokenInfo(threadId, { env = process.env } = {}) {
  const days = codexThreadDays(threadId);
  if (!days) return null;
  const home = String(env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  let active = null;
  for (const day of days) {
    active = await matchingRollout(path.join(home, 'sessions', ...day), threadId);
    if (active) break;
  }
  const archived = active || await matchingRollout(path.join(home, 'archived_sessions'), threadId);
  if (!archived) return null;
  try { return await readLatestCodexTokenInfo(archived); } catch { return null; }
}

/**
 * Одноразовый read-only JSON-RPC клиент. Он не создаёт thread/turn и не вызывает
 * модель: поднимает `codex app-server`, выполняет один безопасный метод и завершает
 * именно запущенный им дочерний процесс.
 */
export function codexAppServerRequest(bin, { method, params } = {}, {
  timeoutMs = APP_SERVER_TIMEOUT_MS,
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error: { message: error?.message || 'Codex app-server не запустился' } });
      return;
    }

    let settled = false;
    let stderr = '';
    let requestSent = false;
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      finish({ error: { message: 'Codex app-server не ответил за отведённое время' } });
    }, timeoutMs);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      resolve(value);
    }

    function send(message) {
      if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.stdin.on('error', (error) => {
      finish({ error: { message: error?.message || 'Не удалось обратиться к Codex app-server' } });
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    child.on('error', (error) => {
      finish({ error: { message: error?.message || 'Codex app-server не запустился' } });
    });
    child.on('close', (code) => {
      if (!settled) {
        finish({
          error: {
            message: stderr.trim() || `Codex app-server завершился с кодом ${code ?? '?'}`,
          },
        });
      }
    });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1 && !requestSent) {
        if (message.error) {
          finish({ error: message.error });
          return;
        }
        requestSent = true;
        send({ method: 'initialized' });
        send({ method, id: 2, ...(params !== undefined && { params }) });
      } else if (message.id === 2) {
        finish(message.error ? { error: message.error } : { result: message.result });
      }
    });

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'cockpit',
          title: 'Cockpit',
          version: '0.1.0',
        },
        capabilities: null,
      },
    });
  });
}

/**
 * Потребление лимитов. Повтор здесь разрешён именно потому, что метод read-only и
 * идемпотентный: он не создаёт thread/turn, ничего не расходует и не меняет аккаунт.
 * Соседнему `consume` такого права не выдано — там повтор означал бы второй списанный
 * сброс лимита.
 *
 * Причина повтора не в самом app-server, а в сети под ним: моргание туннеля роняет
 * единственную попытку, и шапка показывает «не удалось получить лимиты» на живом
 * аккаунте. Пауза между попытками обязательна — мгновенный повтор попадает в то же
 * моргание.
 */
export async function readCodexRateLimits(bin, options = {}) {
  const { sleep, request = codexAppServerRequest, ...rest } = options;
  return withRetry(() => request(bin, { method: 'account/rateLimits/read' }, rest), {
    // Ответ без ошибки — готово. Устаревший CLI и неавторизованный аккаунт — тоже
    // окончательный ответ: повтор их не изменит, а человека задержит на секунды.
    retryWhen: (response) => !!response?.error && !codexUsageErrorIsPermanent(response.error),
    ...(sleep ? { sleep } : {}),
  });
}

export async function consumeCodexRateLimitReset(bin, {
  requestId = '',
  creditId = '',
} = {}, {
  request = codexAppServerRequest,
} = {}) {
  const response = await request(bin, {
    method: 'account/rateLimitResetCredit/consume',
    params: {
      idempotencyKey: String(requestId || randomUUID()),
      ...(String(creditId || '') && { creditId: String(creditId) }),
    },
  });
  if (response?.error) {
    return { ok: false, error: response.error.message || 'Codex не применил сброс лимита' };
  }
  const outcome = response?.result?.outcome;
  if (outcome === 'reset' || outcome === 'alreadyRedeemed') return { ok: true, outcome };
  const messages = {
    nothingToReset: 'Сейчас нет окна лимита, которое можно сбросить.',
    noCredit: 'Доступных сбросов лимита больше нет.',
  };
  return { ok: false, error: messages[outcome] || 'Codex не применил сброс лимита', outcome };
}

async function readCodexModelCatalog(bin) {
  const data = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const response = await codexAppServerRequest(bin, {
      method: 'model/list',
      params: {
        limit: 100,
        includeHidden: true,
        ...(cursor && { cursor }),
      },
    });
    if (response.error || !Array.isArray(response.result?.data)) return null;
    data.push(...response.result.data);
    cursor = response.result.nextCursor || null;
    if (!cursor) break;
  }
  return parseCodexModelList({ data });
}

/**
 * `resume` is an exec subcommand. Sandbox and working-directory flags belong to
 * the parent `codex exec` parser and therefore must precede `resume`; otherwise
 * the second chat message fails before a turn starts.
 */
export function buildCodexExecArgs({
  message,
  cwd,
  extraDirs = [],
  model,
  effort,
  sessionId,
  compactWindow = 0,
}) {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-C', cwd,
  ];
  for (const dir of extraDirs) args.push('--add-dir', dir);
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  // Дефолтное summary у Codex короткое: в ленту приезжал огрызок фразы, и человек
  // видел «обрезанную информацию» вместо размышления. `detailed` просит CLI отдать
  // развёрнутое резюме; приватную цепочку (`raw_content`) normalizer по-прежнему
  // игнорирует. Ключ валидируется самим CLI (проверено: `bogus` → doctor fail).
  args.push('-c', 'model_reasoning_summary="detailed"');
  const compactAt = Math.max(0, Math.round(Number(compactWindow) || 0));
  if (compactAt) args.push('-c', `model_auto_compact_token_limit=${compactAt}`);
  if (sessionId) args.push('resume', '--json', sessionId);
  else args.push('--json');
  args.push(message);
  return args;
}

function codexAppServerConfig(compactWindow) {
  const compactAt = Math.max(0, Math.round(Number(compactWindow) || 0));
  return {
    sandbox_workspace_write: { network_access: true },
    model_reasoning_summary: 'detailed',
    ...(compactAt && { model_auto_compact_token_limit: compactAt }),
  };
}

function codexProcessArgs(providerSettings) {
  if (providerSettings?.blockDirectSsh === false) return ['app-server'];
  const hook = '[{ matcher = "^Bash$", hooks = [{ type = "command", '
    + `command = "${DIRECT_SSH_HOOK_COMMAND}", timeout = 5 }] }]`;
  return [
    '--dangerously-bypass-hook-trust',
    '-c',
    `hooks.PreToolUse=${hook}`,
    'app-server',
  ];
}

function directSshPolicyError(message) {
  const error = new Error(message);
  error.code = 'direct_ssh_policy_unavailable';
  return error;
}

/**
 * Process flags недостаточно принять на веру: app-server мог отбросить их. До
 * thread/start сверяем опубликованный enabled sessionFlags-hook по всем опорным полям.
 */
function assertDirectSshHook(result) {
  const hooks = (Array.isArray(result?.data) ? result.data : [])
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []));
  const found = hooks.some((hook) => (
    hook?.eventName === 'preToolUse'
    && hook?.handlerType === 'command'
    && hook?.command === DIRECT_SSH_HOOK_COMMAND
    && hook?.matcher === DIRECT_SSH_HOOK_MATCHER
    && hook?.source === 'sessionFlags'
    && hook?.enabled === true
  ));
  if (!found) {
    throw directSshPolicyError('Codex не подтвердил server-owned запрет прямого SSH.');
  }
}

function codexWorkspaceRoots(cwd, extraDirs) {
  return [...new Set([cwd, ...(extraDirs || [])].filter(Boolean).map(String))];
}

function codexStoppedError({ sessionId, steps }) {
  const stopped = new Error('Ход остановлен.');
  stopped.stopped = true;
  stopped.steps = steps;
  stopped.contextCache = contextCacheStatus('unavailable');
  stopped.sessionId = sessionId || null;
  return stopped;
}

function codexRpcError(method, error) {
  const detail = String(error?.message || error || 'неизвестная ошибка').slice(-600);
  const wrapped = new Error(`Codex app-server ${method}: ${detail}`);
  if (error?.code !== undefined) wrapped.code = error.code;
  return wrapped;
}

/**
 * Живая сессия Codex: один процесс `codex app-server` держит thread и обслуживает все
 * ходы чата. Раньше он поднимался на КАЖДЫЙ ход и убивался сразу после `turn/completed`,
 * поэтому всё, что агент оставил после себя, умирало вместе с ответом.
 * Замер: два `turn/start` в одном процессе — pid тот же, thread живой, память цела.
 *
 * Разделение простое: соединение (процесс, JSON-RPC, thread) живёт, а ход — это
 * отрезок его потока со своей лентой шагов, своим счётчиком токенов и своим итогом.
 */
export function openCodexSession({
  config, env, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
  providerSettings, log, hooks = {}, tokenInfoReader = readCodexThreadTokenInfo, workTools,
}) {
  const roots = codexWorkspaceRoots(cwd, extraDirs);
  const pending = new Map();
  let nextRequestId = 0;
  let threadId = sessionId || null;
  let actualModel = '';
  let stderrTail = '';
  let protocol = 'pending';
  let exited = false;
  let exitReason = '';
  let turn = null;
  const handledWorkCalls = new Set();

  function rememberTail(current, chunk, limit = 4_000) {
    return `${current}${String(chunk || '')}`.slice(-limit);
  }

  const blockDirectSsh = providerSettings?.blockDirectSsh !== false;
  const child = spawn(config.codexBin, codexProcessArgs(providerSettings), {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });

  function send(payload) {
    if (exited || child.stdin.destroyed) throw new Error('Codex app-server stdin уже закрыт');
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function request(method, params) {
    return new Promise((requestResolve, requestReject) => {
      const id = ++nextRequestId;
      pending.set(id, { method, resolve: requestResolve, reject: requestReject });
      try {
        send({ method, id, ...(params !== undefined && { params }) });
      } catch (error) {
        pending.delete(id);
        requestReject(error);
      }
    });
  }

  function rejectPending(error) {
    const calls = [...pending.values()];
    pending.clear();
    for (const call of calls) call.reject(error);
  }

  /** Состояние ОДНОГО хода: лента, счётчики и итог принадлежат ходу, не сессии. */
  function createTurn({ message, onStep, onProgress }) {
    const stepSink = createStepSink(onStep);
    return {
      message,
      stepSink,
      normalizeStep: createCodexStepNormalizer({ model, cwd }),
      onProgress,
      messageDeltas: new Map(),
      reply: '',
      lastCommentary: '',
      appContext: null,
      progressTokens: 0,
      totalInputTokens: 0,
      cachedInputTokens: 0,
      turnId: null,
      settled: false,
      abortRequested: false,
      interruptSent: false,
      interruptTimer: null,
      resolve: null,
      reject: null,
    };
  }

  function closeTurn(current) {
    clearTimeout(current.interruptTimer);
    if (turn === current) turn = null;
  }

  function finishTurnError(current, error) {
    if (!current || current.settled) return;
    current.settled = true;
    closeTurn(current);
    current.reject(error);
  }

  function finishTurnStopped(current) {
    if (!current || current.settled) return;
    finishTurnError(current, codexStoppedError({ sessionId: threadId, steps: current.stepSink.steps }));
  }

  async function finishTurnSuccess(current) {
    if (!current || current.settled) return;
    // Ход, завершившийся без `final_answer`, всё равно нёс работу: его итог остался
    // в последнем commentary. Дубль в ленте дешевле потерянного ответа, а отказ
    // «codex не вернул ответ» на нормально закрытом turn читается как поломка.
    if (!current.reply.trim() && current.lastCommentary.trim()) current.reply = current.lastCommentary;
    if (!current.reply.trim()) {
      finishTurnError(current, new Error('codex не вернул ответ'));
      return;
    }
    current.settled = true;
    closeTurn(current);

    let context = current.appContext;
    if (!context) {
      try { context = await tokenInfoReader(threadId, { env }); } catch { /* точная метрика необязательна */ }
    }
    current.resolve({
      reply: current.reply,
      sessionId: threadId,
      cost: null,
      contextTokens: context?.contextTokens ?? 0,
      contextWindow: context?.contextWindow ?? 0,
      contextMetric: context?.contextMetric || 'unavailable',
      contextIsEstimate: context ? context.contextIsEstimate === true : true,
      contextCache: context?.contextCache || contextCacheStatus('unavailable'),
      totalInputTokens: context?.totalInputTokens ?? current.totalInputTokens,
      cachedInputTokens: context?.cachedInputTokens ?? current.cachedInputTokens,
      actualModel,
      steps: current.stepSink.steps,
    });
  }

  function rememberUsage(current, params) {
    const usage = params?.tokenUsage;
    const last = usage?.last;
    const total = usage?.total;
    if (!last || !total) return;
    const contextTokens = tokenNumber(last.inputTokens);
    const contextWindow = tokenNumber(usage.modelContextWindow, { positive: true });
    const cachedRequestTokens = tokenNumber(last.cachedInputTokens);
    current.totalInputTokens = tokenNumber(total.inputTokens) || 0;
    current.cachedInputTokens = tokenNumber(total.cachedInputTokens) || 0;
    current.progressTokens = (tokenNumber(last.outputTokens) || 0)
      + (tokenNumber(last.reasoningOutputTokens) || 0);
    if (contextTokens === null || contextWindow === null) return;
    current.appContext = {
      contextTokens,
      contextWindow,
      contextMetric: CODEX_CONTEXT_METRIC,
      contextIsEstimate: false,
      contextCache: cachedRequestTokens === null
        ? contextCacheStatus('unavailable')
        : reportedContextCache({
          readTokens: cachedRequestTokens,
          uncachedTokens: contextTokens - cachedRequestTokens,
        }),
      totalInputTokens: current.totalInputTokens,
      cachedInputTokens: current.cachedInputTokens,
    };
  }

  function appendMessage(current, params) {
    const id = String(params?.itemId || '');
    if (!id || typeof params?.delta !== 'string') return;
    current.messageDeltas.set(id, `${current.messageDeltas.get(id) || ''}${params.delta}`.slice(0, 100_000));
  }

  function maybeInterrupt(current) {
    if (!current || !current.abortRequested || current.interruptSent || current.settled) return;
    if (protocol === 'legacy') {
      finishTurnStopped(current);
      return;
    }
    if (!threadId || !current.turnId) return;
    current.interruptSent = true;
    clearTimeout(current.interruptTimer);
    current.interruptTimer = setTimeout(() => finishTurnStopped(current), 3_000);
    request('turn/interrupt', { threadId, turnId: current.turnId })
      .catch(() => finishTurnStopped(current));
  }

  function consumeAppNotification(event) {
    const method = String(event.method || '');
    const params = event.params && typeof event.params === 'object' ? event.params : {};

    if (method === 'thread/started') {
      threadId = params.thread?.id || threadId;
    }

    const current = turn;
    if (!current) {
      // Событие вне хода: у Codex это служебные уведомления открытой сессии.
      // Ходов «сам заговорил» он не выдаёт (session.unsolicited = false).
      return;
    }
    current.stepSink.emitAll(current.normalizeStep(event));

    if (method === 'turn/started') {
      current.turnId = params.turn?.id || current.turnId;
      maybeInterrupt(current);
    } else if (method === 'item/agentMessage/delta') {
      appendMessage(current, params);
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      const item = params.item;
      const id = String(item.id || '');
      const text = String(item.text || current.messageDeltas.get(id) || '');
      current.messageDeltas.delete(id);
      // Commentary уже ушёл отдельным text-шагом. Ответом считается явный final
      // либо legacy-модель без phase, где последняя agentMessage была ответом.
      if (item.phase === 'final_answer' || item.phase == null) {
        if (text.trim()) current.reply = text;
      } else if (text.trim()) {
        current.lastCommentary = text;
      }
    } else if (method === 'thread/tokenUsage/updated') {
      rememberUsage(current, params);
    } else if (method === 'turn/completed') {
      const status = String(params.turn?.status || 'completed');
      current.turnId = params.turn?.id || current.turnId;
      if (current.progressTokens > 0) {
        try { current.onProgress?.(current.progressTokens); } catch { /* счётчик не должен ронять ход */ }
      }
      if (current.abortRequested || status === 'interrupted') {
        finishTurnStopped(current);
      } else if (status === 'failed') {
        finishTurnError(current, codexRpcError('turn/completed', params.turn?.error || 'ход завершился ошибкой'));
      } else {
        void finishTurnSuccess(current);
      }
    }
  }

  function consumeLegacyEvent(event) {
    protocol = 'legacy';
    if (event.type === 'thread.started') {
      threadId = event.thread_id || event.thread?.id || threadId;
    }
    if (typeof event.model === 'string' && event.model) actualModel = event.model;
    if (typeof event.item?.model === 'string' && event.item.model) actualModel = event.item.model;
    const current = turn;
    if (!current) return;
    current.stepSink.emitAll(current.normalizeStep(event));
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      const text = event.item.text || event.item.content;
      if (typeof text === 'string' && text.trim()) current.reply = text;
    }
    if (event.type === 'turn.completed' && event.usage) {
      current.totalInputTokens = codexTotalInputTokens(event.usage);
      current.cachedInputTokens = tokenNumber(event.usage.cached_input_tokens) || 0;
      const spent = Number(event.usage.output_tokens || 0)
        + Number(event.usage.reasoning_output_tokens || 0);
      if (Number.isFinite(spent) && spent > 0) {
        try { current.onProgress?.(spent); } catch { /* счётчик не должен ронять ход */ }
      }
    }
  }

  function consumeMessage(messageObject) {
    if (messageObject?.id !== undefined && !messageObject?.method
      && (Object.hasOwn(messageObject, 'result') || Object.hasOwn(messageObject, 'error'))) {
      protocol = 'app-server';
      const call = pending.get(messageObject.id);
      if (!call) return;
      pending.delete(messageObject.id);
      if (messageObject.error) call.reject(codexRpcError(call.method, messageObject.error));
      else call.resolve(messageObject.result);
      return;
    }

    if (messageObject?.method) {
      protocol = 'app-server';
      if (messageObject.id !== undefined && messageObject.method === 'item/tool/call') {
        const params = messageObject.params || {};
        const descriptor = (workTools?.descriptors || []).find((item) => (
          item.name === params.tool
        ));
        const valid = descriptor
          && turn
          && params.threadId === threadId
          && params.turnId === turn.turnId
          && !handledWorkCalls.has(String(params.callId || messageObject.id));
        if (!valid) {
          send({
            id: messageObject.id,
            error: { code: -32602, message: 'Некорректный вызов рабочего инструмента' },
          });
          finishTurnError(turn, new Error('Codex прислал некорректный вызов рабочего инструмента'));
          return;
        }
        handledWorkCalls.add(String(params.callId || messageObject.id));
        let input = params.arguments;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            input = null;
          }
        }
        Promise.resolve(workTools.invoke(params.tool, input || {})).then(
          (result) => send({ id: messageObject.id, result }),
          (error) => send({
            id: messageObject.id,
            error: { code: -32603, message: String(error?.message || error) },
          }),
        );
        return;
      }
      // При policy=never запросов разрешения быть не должно. Не оставляем
      // неожиданный server request висеть бесконечно — завершаем ход fail-closed.
      if (messageObject.id !== undefined) {
        try {
          send({
            id: messageObject.id,
            error: { code: -32601, message: `Cockpit не поддерживает server request ${messageObject.method}` },
          });
        } catch { /* основной отказ ниже */ }
        finishTurnError(turn, new Error(`Codex запросил неподдерживаемое действие: ${messageObject.method}`));
        return;
      }
      consumeAppNotification(messageObject);
      return;
    }

    if (messageObject?.type) consumeLegacyEvent(messageObject);
  }

  lines.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text.startsWith('{')) return;
    let event;
    try { event = JSON.parse(text); } catch { return; }
    consumeMessage(event);
  });

  child.stderr.on('data', (chunk) => { stderrTail = rememberTail(stderrTail, chunk); });
  child.stdin.on('error', (error) => { finishTurnError(turn, error); });

  child.once('error', (error) => {
    exited = true;
    exitReason = error?.code === 'ENOENT'
      ? 'GPT-исполнитель не установлен: npm i -g @openai/codex && codex login'
      : (stderrTail || error?.message || 'codex app-server не запустился').slice(-600);
    const failure = new Error(exitReason);
    rejectPending(failure);
    finishTurnError(turn, failure);
    hooks.onExit?.({ reason: exitReason });
  });

  child.once('close', (code) => {
    exited = true;
    const current = turn;
    if (current && !current.settled) {
      if (current.abortRequested) {
        finishTurnStopped(current);
      } else if (protocol === 'legacy' && current.reply) {
        void finishTurnSuccess(current);
      } else {
        const detail = stderrTail.trim().slice(-300);
        finishTurnError(current, new Error(
          `codex app-server завершился до ответа${detail ? `: ${detail}` : ` (код ${code ?? '?'})`}`,
        ));
      }
    }
    if (!exitReason) exitReason = `codex app-server завершился (код ${code ?? '?'})`;
    rejectPending(new Error(exitReason));
    hooks.onExit?.({ code, reason: exitReason });
  });

  const ready = (async () => {
    await request('initialize', {
      clientInfo: { name: 'cockpit', title: 'Cockpit', version: '0.1.0' },
      // `experimentalApi` открывает `runtimeWorkspaceRoots`: без него app-server
      // отвечает «requires experimentalApi capability», и рабочим корнем остаётся
      // один cwd (в схеме: «Omitted defaults to cwd»). `requestAttestation` —
      // строго false: он включает server request `attestation/generate`, а любой
      // server request кокпит завершает fail-closed, то есть уронил бы ход.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    send({ method: 'initialized' });
    if (blockDirectSsh) {
      assertDirectSshHook(await request('hooks/list', {}));
    }

    const common = {
      ...(model && { model }),
      cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      // Доверенные каталоги «Настройки → Исполнители» обязаны быть рабочими корнями,
      // а не только writable-песочницей: `codex exec --add-dir` давал агенту именно
      // рабочую область, и после переезда на app-server она сузилась до cwd.
      runtimeWorkspaceRoots: roots,
      config: codexAppServerConfig(compactWindow),
      ...((workTools?.descriptors || []).length
        ? { dynamicTools: workTools.descriptors }
        : {}),
    };
    const opened = threadId
      ? await request('thread/resume', { threadId, ...common })
      : await request('thread/start', { ...common, serviceName: 'cockpit' });
    threadId = opened?.thread?.id || opened?.thread?.sessionId || threadId;
    actualModel = String(opened?.model || model || '');
    return threadId;
  })();
  // Отказ handshake разбирает тот, кто делает первый ход: без этого он остался бы
  // необработанным rejection и уронил бы процесс сервера.
  ready.catch(() => {});

  return {
    get pid() { return child.pid; },
    get sessionId() { return threadId; },
    get alive() { return !exited; },
    get busy() { return !!turn; },

    async send({ message, onStep, onProgress }) {
      if (exited) throw new Error(exitReason || 'Сессия Codex закрыта.');
      if (turn) throw new Error('В этой сессии уже идёт ход.');

      // Ход объявляется ДО ожидания handshake: «стоп» может прийти, пока app-server
      // ещё поднимается, и прерывать тогда будет нечего — запрос повис бы до таймаута.
      const current = createTurn({ message, onStep, onProgress });
      turn = current;
      const result = new Promise((resolve, reject) => {
        current.resolve = resolve;
        current.reject = reject;
      });
      // Стоп может отклонить ход РАНЬШЕ, чем этот промис вернётся вызывающему: пустой
      // catch помечает его обработанным, не мешая настоящему await получить ту же ошибку.
      result.catch(() => {});

      try {
        await ready;
        if (current.settled) return result;
        current.stepSink.emitAll(current.normalizeStep({
          type: 'thread.started', thread_id: threadId, model: actualModel,
        }));

        const started = await request('turn/start', {
          threadId,
          input: [{ type: 'text', text: String(message || ''), text_elements: [] }],
          cwd,
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: roots,
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          ...(model && { model }),
          ...(effort && { effort }),
          summary: 'detailed',
        });
        current.turnId = started?.turn?.id || current.turnId;
        maybeInterrupt(current);
      } catch (error) {
        finishTurnError(current, error);
      }
      return result;
    },

    /** «Стоп» человека: прерываем ход штатным turn/interrupt, thread остаётся живым. */
    async interrupt() {
      const current = turn;
      if (!current || current.settled) return;
      current.abortRequested = true;
      maybeInterrupt(current);
      if (!current.interruptTimer && protocol !== 'legacy') {
        // Если стоп пришёл до turn/started, даём app-server короткое окно сообщить id.
        current.interruptTimer = setTimeout(() => finishTurnStopped(current), 3_000);
      }
    },

    async close() {
      if (exited) return;
      try { lines.close(); } catch { /* уже закрыт */ }
      try { child.stdin.end(); } catch { /* уже закрыт */ }
      try { child.kill(); } catch { /* уже завершён */ }
      exited = true;
    },
  };
}

/**
 * Разовый ход: та же сессия, поднятая ради одного хода и погашенная сразу после.
 * Остаётся для исполнителей и путей, где живая сессия не нужна или отключена.
 */
export async function runCodexAppServer({
  config, env, message, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
  providerSettings, signal, onProgress, onStep, tokenInfoReader = readCodexThreadTokenInfo,
  workTools,
}) {
  if (signal?.aborted) throw codexStoppedError({ sessionId, steps: [] });

  const session = openCodexSession({
    config, env, cwd, extraDirs, model, effort, sessionId, compactWindow, providerSettings,
    tokenInfoReader, workTools,
  });
  const onAbort = () => { void session.interrupt(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await session.send({ message, onStep, onProgress });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await session.close();
  }
}

// TUI-команды Codex. `codex exec` слэш-текст отдаёт модели как обычный промпт, поэтому
// весь список информационный (run: 'none'): исполнить их можно только в интерактивном
// TUI самого CLI. Состав сверен contract gate с codex-cli 0.145.0;
// /undo, /quit, /exit в этой версии отсутствуют.
const CODEX_TUI_HINT = 'Исполняется только в TUI Codex';
const CODEX_TUI_COMMANDS = [
  { cmd: '/model', desc: 'Сменить модель и уровень рассуждений' },
  { cmd: '/approvals', desc: 'Режим согласования действий агента' },
  { cmd: '/status', desc: 'Состояние сессии и конфигурации' },
  { cmd: '/review', desc: 'Ревизия изменений рабочего дерева' },
  { cmd: '/diff', desc: 'Показать diff рабочего дерева' },
  { cmd: '/new', desc: 'Начать новую сессию' },
  { cmd: '/resume', desc: 'Возобновить сохранённую сессию' },
  { cmd: '/fork', desc: 'Ответвить текущую сессию' },
  { cmd: '/init', desc: 'Сгенерировать AGENTS.md' },
  { cmd: '/mcp', desc: 'Состояние MCP-серверов' },
  { cmd: '/skills', desc: 'Список доступных скиллов' },
  { cmd: '/goal', desc: 'Поставить автономную цель' },
  { cmd: '/feedback', desc: 'Отправить отзыв разработчикам' },
  { cmd: '/help', desc: 'Справка по командам' },
  { cmd: '/compact', desc: 'Сжать контекст разговора' },
].map((c) => ({ ...c, run: 'none', hint: CODEX_TUI_HINT }));

/**
 * `skills/list` — канонический источник навыков самого Codex. В глобальный
 * `/api/providers` берём только cwd-независимые области: repo-skill может быть
 * доступен свободному чату, но исчезнуть в task-chat с другим worktree.
 */
export function parseCodexSkillCommands(result) {
  const rows = Array.isArray(result?.data) ? result.data : [];
  const skills = rows.flatMap((row) => (Array.isArray(row?.skills) ? row.skills : []));
  const seen = new Set();
  const commands = [];
  for (const skill of skills) {
    const name = String(skill?.name || '').trim();
    if (skill?.enabled !== true || skill?.scope === 'repo'
      || !['user', 'admin', 'system'].includes(skill?.scope)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
      || seen.has(name)) continue;
    seen.add(name);
    const description = skill?.interface?.shortDescription
      || skill?.shortDescription
      || skill?.description
      || 'Навык Codex';
    commands.push({
      cmd: `$${name}`,
      desc: String(description).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Навык Codex',
      run: 'prompt',
    });
  }
  return commands;
}

export async function readCodexSkillCommands(bin, cwd, {
  request = codexAppServerRequest,
} = {}) {
  if (!bin || !cwd) return [];
  const response = await request(bin, {
    method: 'skills/list',
    params: { cwds: [cwd], forceReload: true },
  }, { timeoutMs: 5_000 });
  if (response?.error) return [];
  return parseCodexSkillCommands(response?.result);
}

export default {
  id: 'codex',
  name: 'GPT (Codex)',
  vendor: 'OpenAI',
  color: '#10a37f',
  order: 2,
  install: 'npm i -g @openai/codex && codex login',
  // Каждый путь из opts.extraDirs становится writableRoot sandboxPolicy хода.
  trustedDirectories: true,
  directSshPolicy: { enforcement: 'command-hook' },
  settings: [directSshSetting()],

  // Ручной компакт пока идёт универсальной выжимкой текстом. Автокомпакт родной:
  // thread config передаёт app-server-у официальный model_auto_compact_token_limit.
  compaction: { kind: 'summary' },

  bin(config) { return config.codexBin; },

  async commands(config) {
    const skills = await readCodexSkillCommands(config?.codexBin, config?.rootDir);
    return [...CODEX_TUI_COMMANDS, ...skills];
  },

  probe(config) {
    return new Promise((resolve) => {
      execFile(config.codexBin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return resolve({ ok: false, version: null });
        resolve({ ok: true, version: (stdout || '').trim().slice(0, 60) || null });
      });
    });
  },

  /**
   * Авторизация — файл ~/.codex/auth.json (создаётся `codex login`).
   */
  async auth() {
    try {
      await fs.access(path.join(os.homedir(), '.codex', 'auth.json'));
      return { mode: 'cli', label: 'CLI хоста (codex login)', available: true };
    } catch {
      return { mode: 'none', label: 'не авторизован (codex login)', available: false };
    }
  },

  /**
   * Потребление лимитов ChatGPT/Codex через официальный read-only app-server API.
   * Вызов не запускает модель и не читает историю сессий.
   */
  async usage(config) {
    return classifyCodexUsageResponse(await readCodexRateLimits(config.codexBin));
  },

  usageActions: {
    'consume-rate-limit-reset': ({ config, payload, requestId }) => consumeCodexRateLimitReset(
      config.codexBin,
      { requestId, creditId: payload.creditId },
    ),
  },

  /**
   * Модели, доступные именно этому Codex-аккаунту. App-server сам учитывает версию
   * CLI, авторизацию, rollout и скрытые модели; API-ключ Platform не нужен.
   */
  catalog(config) {
    return readCodexModelCatalog(config.codexBin);
  },
  catalogLive: true,

  /** Стабильное семейство для policy агентов и движка. */
  modelFamily(model) {
    return String(model?.family || codexModelFamily(model?.id)).trim();
  },

  /**
   * Обновление CLI (кнопка «Обновить» в настройках → «Исполнители»).
   * Само не запускается — только по нажатию пользователя.
   */
  updateCmd: ['update'],

  /**
   * Последняя опубликованная версия — для индикатора «доступно обновление».
   */
  latestVersion() {
    return npmLatest('@openai/codex');
  },

  seedModels() {
    return [
      {
        id: 'gpt-5.6-sol', family: 'sol', name: 'GPT-5.6-Sol', tier: 100, efforts: null,
        ...codexCatalogContext(null),
      },
      {
        id: 'gpt-5.6-terra', family: 'terra', name: 'GPT-5.6-Terra', tier: 90, efforts: null,
        ...codexCatalogContext(null),
      },
      {
        id: 'gpt-5.6-luna', family: 'luna', name: 'GPT-5.6-Luna', tier: 80, efforts: null,
        ...codexCatalogContext(null),
      },
    ];
  },

  run({
    config, env, message, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
    providerSettings, signal, onProgress, onStep, tokenInfoReader = readCodexThreadTokenInfo,
    workTools,
  }) {
    return runCodexAppServer({
      config, env, message, cwd, extraDirs, model, effort, sessionId, compactWindow,
      providerSettings, signal, onProgress, onStep, tokenInfoReader, workTools,
    });
  },

  /**
   * Живая сессия: `codex app-server` — сам по себе сервер, и держать его между ходами
   * дешевле, чем поднимать заново. Замер: два `turn/start` в одном процессе, pid тот же.
   *
   * `unsolicited: false` — Codex не будит модель сам: фоновых агентов, которые
   * отчитались бы без запроса, у него нет. Живая сессия всё равно нужна: она сохраняет
   * рабочее состояние процесса и позволяет разбудить агента сообщением от кокпита.
   */
  session: {
    mode: 'persistent',
    unsolicited: false,
    restartOn: [
      'model',
      'effort',
      'cwd',
      'extraDirs',
      'compactWindow',
      'providerSettings',
      'workToolScopeKey',
    ],

    open({
      config, env, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
      providerSettings, log, hooks, workTools,
    }) {
      return openCodexSession({
        config, env, cwd, extraDirs, model, effort, sessionId, compactWindow,
        providerSettings, log, hooks, workTools,
      });
    },
  },
};
