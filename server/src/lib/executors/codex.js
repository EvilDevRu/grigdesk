// Исполнитель GPT (OpenAI Codex CLI).
// Установка: npm i -g @openai/codex && codex login — после этого провайдер оживает сам.
// Запуск неинтерактивный: `codex exec --json` (JSONL-события), резюме через
// `codex exec resume <thread_id>`. Песочница workspace-write: текущий cwd и явно
// доверенные каталоги доступны для правок, сеть включена для gh/git/package CLI,
// остальная файловая система закрыта.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { npmLatest } from './_npm-latest.js';
import { createStepSink } from '../chat/stream-steps.js';
import { createCodexStepNormalizer } from './_codex-steps.js';

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
 * Documented app-server contract: account/rateLimits/read. `rateLimitsByLimitId`
 * is the current multi-bucket view; `rateLimits` remains its compatibility
 * fallback. Model names come from the service, so new Codex families do not
 * require a Cockpit release.
 */
export function parseCodexRateLimits(result) {
  const byId = result?.rateLimitsByLimitId;
  const buckets = byId && typeof byId === 'object' && Object.keys(byId).length
    ? Object.values(byId)
    : (result?.rateLimits ? [result.rateLimits] : []);
  const bars = [];
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const id = String(bucket.limitId || 'codex');
    const scope = bucket.limitName || (id !== 'codex' ? id : '');
    for (const slot of ['primary', 'secondary']) {
      const limit = bucket[slot];
      if (!limit || typeof limit.usedPercent !== 'number') continue;
      const base = windowLabel(limit.windowDurationMins);
      bars.push({
        key: `${id}:${slot}`,
        label: scope ? `${base.replace(/ \([^)]+\)$/, '')} · ${scope}` : base,
        pct: clamp(limit.usedPercent),
        resetsAt: resetIso(limit.resetsAt),
      });
    }
  }
  return bars;
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

export function classifyCodexUsageResponse({ result = null, error = null } = {}) {
  const detail = String(error?.message || error || '').slice(0, 500);
  if (error) {
    if (error?.code === -32601 || /method not found/i.test(detail)) {
      return {
        state: 'unsupported',
        bars: [],
        message: 'Установленная версия Codex не умеет отдавать лимиты. Обнови CLI в настройках.',
        detail,
        action: null,
      };
    }
    if (/login|required|sign.?in|unauthori[sz]ed|not authenticated|401/i.test(detail)) {
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
      context: Number(exact.contextWindow) || 400_000,
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
  const contextWindow = tokenNumber(info?.model_context_window, { positive: true });
  if (contextTokens === null || contextWindow === null) return null;
  return {
    contextTokens,
    contextWindow,
    contextMetric: CODEX_CONTEXT_METRIC,
    contextIsEstimate: false,
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
        send({ method: 'initialized', params: {} });
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
      },
    });
  });
}

export function readCodexRateLimits(bin, options = {}) {
  return codexAppServerRequest(bin, { method: 'account/rateLimits/read' }, options);
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
  const compactAt = Math.max(0, Math.round(Number(compactWindow) || 0));
  if (compactAt) args.push('-c', `model_auto_compact_token_limit=${compactAt}`);
  if (sessionId) args.push('resume', '--json', sessionId);
  else args.push('--json');
  args.push(message);
  return args;
}

// TUI-команды Codex. `codex exec` слэш-текст отдаёт модели как обычный промпт, поэтому
// весь список информационный (run: 'none'): исполнить их можно только в интерактивном
// TUI самого CLI. Состав сверен с бинарём codex-cli 0.145.0 (гейт 2026-08-06);
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

export default {
  id: 'codex',
  name: 'GPT (Codex)',
  vendor: 'OpenAI',
  color: '#10a37f',
  order: 2,
  install: 'npm i -g @openai/codex && codex login',

  // Ручной компакт пока идёт универсальным путём: `codex exec` принимает prompt, а
  // app-server `thread/compact/start` потребовал бы другого transport. Автокомпакт при
  // этом родной: buildCodexExecArgs передаёт официальный model_auto_compact_token_limit.
  compaction: { kind: 'summary' },

  bin(config) { return config.codexBin; },

  commands() { return CODEX_TUI_COMMANDS; },

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
      { id: 'gpt-5.6-sol', family: 'sol', name: 'GPT-5.6-Sol', context: 400000, tier: 100, efforts: null },
      { id: 'gpt-5.6-terra', family: 'terra', name: 'GPT-5.6-Terra', context: 400000, tier: 90, efforts: null },
      { id: 'gpt-5.6-luna', family: 'luna', name: 'GPT-5.6-Luna', context: 400000, tier: 80, efforts: null },
    ];
  },

  run({
    config, env, message, cwd, extraDirs = [], model, effort, sessionId, compactWindow,
    signal, onProgress, onStep, tokenInfoReader = readCodexThreadTokenInfo,
  }) {
    const args = buildCodexExecArgs({
      message, cwd, extraDirs, model, effort, sessionId, compactWindow,
    });

    return new Promise((resolve, reject) => {
      // execFile отдаёт stdout только после завершения, поэтому лента Codex раньше
      // была пустой. Spawn читается построчно: provider-normalizer превращает каждое
      // JSONL-событие в общий ChatStep и сразу отправляет его в SSE.
      const stepSink = createStepSink(onStep);
      const normalizeStep = createCodexStepNormalizer({ model, cwd });
      let threadId = sessionId || null;
      let reply = '';
      let totalInputTokens = 0;
      let cachedInputTokens = 0;
      let actualModel = '';
      let stderrTail = '';
      let buffer = '';
      let settled = false;

      function finishError(error) {
        if (settled) return;
        settled = true;
        reject(error);
      }

      function finishStopped() {
        if (settled) return;
        const stopped = new Error('Ход остановлен.');
        stopped.stopped = true;
        stopped.steps = stepSink.steps;
        // Даже оборванный первый ход успевает напечатать thread.started. Сохраняем id:
        // следующий вопрос сможет продолжить тот же разговор после кнопки «стоп».
        stopped.sessionId = threadId;
        finishError(stopped);
      }

      function rememberTail(current, chunk, limit = 4_000) {
        return `${current}${String(chunk || '')}`.slice(-limit);
      }

      function consumeEvent(event) {
        if (event.type === 'thread.started') {
          threadId = event.thread_id || event.thread?.id || threadId;
        }
        if (typeof event.model === 'string' && event.model) actualModel = event.model;
        if (typeof event.item?.model === 'string' && event.item.model) actualModel = event.item.model;

        stepSink.emitAll(normalizeStep(event));

        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          const text = event.item.text || event.item.content;
          if (typeof text === 'string' && text.trim()) reply = text;
        }
        if (event.type === 'turn.completed') {
          if (typeof event.last_agent_message === 'string' && event.last_agent_message.trim()) {
            reply = event.last_agent_message;
          }
          if (event.usage) {
            totalInputTokens = codexTotalInputTokens(event.usage);
            cachedInputTokens = tokenNumber(event.usage.cached_input_tokens) || 0;
            const spent = Number(event.usage.output_tokens || 0) + Number(event.usage.reasoning_output_tokens || 0);
            if (Number.isFinite(spent) && spent > 0) {
              try { onProgress?.(spent); } catch { /* счётчик не должен ронять ход */ }
            }
          }
        }
      }

      function consumeLine(line) {
        const text = line.trim();
        if (!text.startsWith('{')) return;
        let event;
        try { event = JSON.parse(text); } catch { return; }
        consumeEvent(event);
      }

      function consumeBuffer() {
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          consumeLine(line);
        }
      }

      let child;
      try {
        child = spawn(config.codexBin, args, {
          cwd,
          env,
          signal,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finishError(error);
        return;
      }

      child.stdout?.on('data', (chunk) => {
        buffer += String(chunk);
        consumeBuffer();
      });
      child.stderr?.on('data', (chunk) => {
        stderrTail = rememberTail(stderrTail, chunk);
      });
      child.once('error', (error) => {
        if (error?.code === 'ABORT_ERR' || signal?.aborted) return finishStopped();
        if (error?.code === 'ENOENT') {
          return finishError(new Error('GPT-исполнитель не установлен: npm i -g @openai/codex && codex login'));
        }
        return finishError(new Error((stderrTail || error?.message || 'codex не запустился').slice(-600)));
      });
      child.once('close', async (code) => {
        if (buffer.trim()) consumeLine(buffer);
        buffer = '';
        if (settled) return;
        if (signal?.aborted) return finishStopped();
        if (!reply) {
          const detail = stderrTail.trim().slice(-300);
          return finishError(new Error(`codex не вернул ответ${detail ? `: ${detail}` : ` (код ${code ?? '?'})`}`));
        }
        settled = true;
        let context = null;
        try { context = await tokenInfoReader(threadId, { env }); } catch { /* без точной метрики лучше пусто, чем миллионы */ }
        resolve({
          reply, sessionId: threadId, cost: null,
          contextTokens: context?.contextTokens ?? 0,
          contextWindow: context?.contextWindow ?? 0,
          contextMetric: context?.contextMetric || 'unavailable',
          contextIsEstimate: !context,
          totalInputTokens: context?.totalInputTokens ?? totalInputTokens,
          cachedInputTokens: context?.cachedInputTokens ?? cachedInputTokens,
          actualModel, steps: stepSink.steps,
        });
      });
    });
  },
};
