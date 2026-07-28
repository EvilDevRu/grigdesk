// Исполнитель Claude (Anthropic, Claude Code CLI).
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCatalog } from './_claude-catalog.js';
import { npmLatest } from './_npm-latest.js';
import { toStep } from '../chat/stream-steps.js';

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
// Дефолтный месячный потолок при первом включении доплаты — как у CLI (2000 = 20.00).
const DEFAULT_LIMIT_MINOR = 2000;

async function cliToken() {
  try {
    const creds = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    return creds?.claudeAiOauth?.accessToken || null;
  } catch { return null; } // CLI-кредов нет
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
async function fetchUsage() {
  const tok = await cliToken();
  if (!tok) return null;
  let r = null;
  for (let i = 0; i < 2 && !r?.ok; i++) {
    r = await fetch(`${API}/api/oauth/usage`, {
      headers: authHeaders(tok),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
  }
  if (!r?.ok) return null;
  return r.json().catch(() => null);
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

export default {
  id: 'claude',
  name: 'Claude',
  vendor: 'Anthropic',
  color: '#d97757',
  order: 1,
  install: 'npm i -g @anthropic-ai/claude-code && claude login',

  bin(config) { return config.claudeBin; },

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
   * Уровни эффорта — из `claude --help` («--effort <level> … (low, medium, high, max)»):
   * добавит Anthropic новый уровень — подхватится без правок кода.
   */
  async efforts(config) {
    const out = await exec(config.claudeBin, ['--help']);
    const m = (out || '').match(/--effort[^\n]*\(([^)]+)\)/);
    if (!m) return null;
    const levels = m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return levels.length ? levels : null;
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
  async usage() {
    const d = await fetchUsage();
    if (!d) return null;
    const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
    const bars = [];
    // Каноничный источник — массив limits (из него строится и официальная панель /usage):
    // session, weekly_all и weekly_scoped с именем модели (например «Fable»).
    const KIND = { session: 'Сессия (5ч)', weekly_all: 'Неделя (7д)' };
    for (const l of d.limits || []) {
      if (typeof l.percent !== 'number') continue;
      let label = KIND[l.kind] || l.kind.replace(/_/g, ' ');
      if (l.kind === 'weekly_scoped') label = `Неделя · ${l.scope?.model?.display_name || l.scope?.surface || '?'}`;
      bars.push({
        key: l.kind + (l.scope?.model?.display_name || ''),
        label,
        pct: clamp(l.percent),
        resetsAt: l.resets_at || null,
      });
    }
    // Extra usage (доплата сверх лимитов) — отдельной строкой с потраченным бюджетом.
    // Строка есть ВСЕГДА, даже когда доплата выключена: на ней висит управление
    // (тумблер и потолок), а управлять невидимым нельзя. `credits` — признак для UI,
    // что у этой полосы есть органы управления.
    const c = creditsOf(d);
    if (c) {
      bars.push({
        key: 'extra_usage',
        label: 'Extra usage (доплата)',
        pct: c.enabled && c.utilization !== null ? clamp(c.utilization) : 0,
        resetsAt: null,
        note: creditsNote(c),
        credits: c,
      });
    }
    // Фоллбэк на старую плоскую форму, если limits в ответе нет.
    if (!bars.length) {
      for (const [k, v] of Object.entries(d || {})) {
        if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue;
        bars.push({ key: k, label: k.replace(/_/g, ' '), pct: clamp(v.utilization), resetsAt: v.resets_at || null });
      }
    }
    return bars.length ? bars : null;
  },

  /**
   * Управление доплатой сверх лимитов — то же, что `/usage-credits` в CLI.
   * `patch`: `{ enabled?: boolean, limit?: number }` (потолок — в валюте счёта).
   *
   * Порядок вызовов повторяет CLI: при ПЕРВОМ включении доплату сначала надо завести
   * (`setup_overage_billing`), и только потом поднимать флаг. Повторный setup на уже
   * заведённом аккаунте безобиден — его ошибку глотаем, решает следующий PUT.
   *
   * Снятие потолка («без ограничения») сознательно не поддержано: это счёт без верхней
   * границы, такое делают на claude.ai осознанно, а не тумблером в шапке.
   */
  async setCredits(config, deps, patch = {}) {
    const tok = await cliToken();
    if (!tok) return { ok: false, error: 'Нет токена хостового CLI — авторизуйся на хосте: claude login' };

    const state = creditsOf(await fetchUsage());
    if (!state) return { ok: false, error: 'Anthropic не отдал состояние доплаты — попробуй позже' };

    const wantEnabled = patch.enabled === undefined ? state.enabled : !!patch.enabled;
    const limit = patch.limit;
    if (limit !== undefined && !(typeof limit === 'number' && limit > 0)) {
      return { ok: false, error: 'Месячный потолок — положительное число' };
    }
    // Менять потолок у выключенной доплаты бессмысленно: PUT поднял бы её молча.
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
    return { ok: true, credits: creditsOf(await fetchUsage()) };
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
      { id: 'opus', name: 'Opus — последняя', context: 200000, tier: 8995, efforts: null, alias: true },
      { id: 'sonnet', name: 'Sonnet — последняя', context: 200000, tier: 6995, efforts: null, alias: true },
      { id: 'haiku', name: 'Haiku — последняя', context: 200000, tier: 3995, efforts: null, alias: true },
    ];
  },

  /**
   * Запуск: claude -p с резюмом сессии, MCP-конфигом всплывашки разрешений и т.д.
   * Вывод — stream-json: по ходу работы считаем потраченные токены (onProgress →
   * «думает… · N ток.») и разбираем события в ШАГИ (onStep → лента инструментов
   * и размышлений в чате, как в VS Code).
   * Возвращает { reply, sessionId, contextTokens, cost, actualModel, steps } или бросает Error.
   */
  run({ config, env, message, cwd, extraDirs = [], model, effort, sessionId, permissionMode, mcpConfig, permissionPromptTool, log, onProgress, onStep, signal }) {
    const args = ['-p', message, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode || 'default'];
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
      const steps = [];
      // Модель, которой CLI ФАКТИЧЕСКИ отработал: алиас `opus` он резолвит сам,
      // и это единственный способ увидеть рассинхрон с выбором в кокпите.
      let actualModel = '';
      // id сессии CLI ловим ИЗ ПОТОКА, а не только из финального result: у оборванного
      // хода (кнопка «стоп», лимит) результата нет, и без этого id новая сессия оставалась
      // безымянной — следующий вопрос уходил без --resume, и агент забывал разговор.
      let streamSessionId = '';
      const pushSteps = (ev) => {
        for (const s of toStep(ev)) {
          // at — чтобы в ленте было видно, сколько агент думал (как «Thought for 49s»).
          s.at = Date.now();
          if (steps.length < 400) steps.push(s);
          try { onStep?.(s); } catch { /* лента не критична для хода */ }
        }
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
