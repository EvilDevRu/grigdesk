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
 */
function exec(bin, args, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout }, (err, stdout) => resolve(err ? null : (stdout || '')));
  });
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
    const out = await exec(config.claudeBin, ['--version'], 10_000);
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
   * Потребление лимитов подписки (как /usage в CLI): прогрессбары «Сессия (5ч)»,
   * «Неделя» и пр. Ручка OAuth-подписки — работает только с токеном хостового CLI
   * (~/.claude/.credentials.json); пользователь явно попросил эту статистику.
   */
  async usage() {
    let tok = null;
    try {
      const creds = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
      tok = creds?.claudeAiOauth?.accessToken || null;
    } catch { /* CLI-кредов нет */ }
    if (!tok) return null;
    // Сеть до api.anthropic.com бывает нестабильна (VPN) — пробуем дважды.
    let r = null;
    for (let i = 0; i < 2 && !r?.ok; i++) {
      r = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${tok}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
    }
    if (!r?.ok) return null;
    const d = await r.json();
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
    const x = d.extra_usage;
    if (x?.is_enabled && typeof x.utilization === 'number') {
      const dp = 10 ** (x.decimal_places ?? 2);
      bars.push({
        key: 'extra_usage',
        label: 'Extra usage (доплата)',
        pct: clamp(x.utilization),
        resetsAt: null,
        note: `${Math.round(x.used_credits / dp)} из ${Math.round(x.monthly_limit / dp)} ${x.currency || ''}`,
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
      const pushSteps = (ev) => {
        for (const s of toStep(ev)) {
          // at — чтобы в ленте было видно, сколько агент думал (как «Thought for 49s»).
          s.at = Date.now();
          if (steps.length < 400) steps.push(s);
          try { onStep?.(s); } catch { /* лента не критична для хода */ }
        }
      };
      const timeoutMs = config.chatTimeoutMs || 3600000;
      // signal — кнопка «стоп» в чате: Node сам убьёт процесс, а мы отличим остановку
      // от таймаута по коду ошибки (ABORT_ERR) и вернём понятный текст, а не «код null».
      const child = execFile(config.claudeBin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, signal }, (err, stdout, stderr) => {
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
            return reject(stopped);
          }
          if (err?.killed) return reject(new Error(`Агент не уложился в лимит ${Math.round(timeoutMs / 60000)} мин — возможно, ждал разрешения во всплывашке или задача слишком большая.`));
          const tail = (stderr || '').trim().slice(-600);
          return reject(new Error(tail || `claude завершился без результата (код ${err?.code ?? '?'})`));
        }
        const j = resultEv;
        // Размер контекста = входные токены ПОСЛЕДНЕГО хода (из потока assistant-событий).
        // result.usage — это СУММА за все ходы, она может многократно превышать окно.
        const contextTokens = lastTurnInput || ((u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0))(j.usage || {});
        // Пустой result — агент завершил ход без текста (не разрешили действие, лимит шагов).
        let reply = j.result || '';
        if (!reply) {
          log?.warn({ subtype: j.subtype, turns: j.num_turns, denials: j.permission_denials }, 'чат: пустой result от claude');
          // AskUserQuestion кокпит «отклоняет» намеренно — так ответ пользователя доезжает
          // до агента (см. modules/chat). Это не отказ в действии, в текст его не тащим.
          const denied = [...new Set((j.permission_denials || []).map((d) => d.tool_name).filter((n) => n && n !== 'AskUserQuestion'))];
          if (j.subtype === 'error_max_turns') reply = '⚠ Агент упёрся в лимит шагов и не успел сформулировать ответ. Переформулируй запрос или разбей его на части.';
          else if (denied.length) reply = `⚠ Действия не были разрешены (${denied.join(', ')}) — агент завершил ход без ответа. Разреши действие во всплывашке или переформулируй запрос.`;
          else reply = '⚠ Агент завершил ход без текстового ответа. Повтори вопрос — контекст сохранён.';
        }
        resolve({
          reply, sessionId: j.session_id || sessionId || null, cost: j.total_cost_usd ?? null,
          contextTokens, actualModel, steps,
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
          if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
            actualModel = ev.model;
          } else if (ev.type === 'assistant' && ev.message?.usage) {
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
