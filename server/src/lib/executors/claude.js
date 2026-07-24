// Исполнитель Claude (Anthropic, Claude Code CLI).
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${tok}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const LABELS = {
      five_hour: 'Сессия (5ч)',
      seven_day: 'Неделя (7д)',
      seven_day_opus: 'Неделя · Opus',
      seven_day_sonnet: 'Неделя · Sonnet',
      seven_day_fable: 'Неделя · Fable',
      seven_day_oauth_apps: 'Неделя · приложения',
    };
    const bars = [];
    for (const [k, v] of Object.entries(d || {})) {
      if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue;
      bars.push({
        key: k,
        label: LABELS[k] || k.replace(/_/g, ' '),
        pct: Math.max(0, Math.min(100, Math.round(v.utilization))),
        resetsAt: v.resets_at || null,
      });
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
   * Стартовый сид моделей (дальше живёт в редактируемом models.json).
   * efforts: null = взять динамически обнаруженные у CLI.
   */
  seedModels() {
    return [
      // fable — алиаса в CLI нет, только полный ID
      { id: 'claude-fable-5', name: 'Fable 5', context: 200000, tier: 100, efforts: null },
      { id: 'opus', name: 'Opus 4.8', context: 200000, tier: 90, efforts: null },
      { id: 'sonnet', name: 'Sonnet 5', context: 200000, tier: 80, efforts: null },
      { id: 'haiku', name: 'Haiku 4.5', context: 200000, tier: 40, efforts: null },
    ];
  },

  /**
   * Запуск: claude -p с резюмом сессии, MCP-конфигом всплывашки разрешений и т.д.
   * Вывод — stream-json: по ходу работы считаем потраченные токены и дёргаем
   * onProgress (кокпит транслирует в UI «думает… · N ток.»).
   * Возвращает { reply, sessionId, contextTokens, cost } или бросает Error.
   */
  run({ config, env, message, cwd, extraDirs = [], model, effort, sessionId, permissionMode, mcpConfig, permissionPromptTool, log, onProgress }) {
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
      let buf = '';
      const timeoutMs = config.chatTimeoutMs || 3600000;
      const child = execFile(config.claudeBin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        // Подстраховка: финальная строка могла остаться в буфере без \n.
        if (!resultEv) {
          for (const line of (buf + '\n' + (stdout || '')).split('\n')) {
            const t = line.trim();
            if (!t.startsWith('{')) continue;
            try { const ev = JSON.parse(t); if (ev.type === 'result') resultEv = ev; } catch { /* мусор */ }
          }
        }
        if (!resultEv) {
          if (err?.killed) return reject(new Error(`Агент не уложился в лимит ${Math.round(timeoutMs / 60000)} мин — возможно, ждал разрешения во всплывашке или задача слишком большая.`));
          const tail = (stderr || '').trim().slice(-600);
          return reject(new Error(tail || `claude завершился без результата (код ${err?.code ?? '?'})`));
        }
        const j = resultEv;
        const u = j.usage || {};
        // Размер контекста = все входные токены последнего запроса (обычные + кэш).
        const contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        // Пустой result — агент завершил ход без текста (не разрешили действие, лимит шагов).
        let reply = j.result || '';
        if (!reply) {
          log?.warn({ subtype: j.subtype, turns: j.num_turns, denials: j.permission_denials }, 'чат: пустой result от claude');
          const denied = [...new Set((j.permission_denials || []).map((d) => d.tool_name).filter(Boolean))];
          if (j.subtype === 'error_max_turns') reply = '⚠ Агент упёрся в лимит шагов и не успел сформулировать ответ. Переформулируй запрос или разбей его на части.';
          else if (denied.length) reply = `⚠ Действия не были разрешены (${denied.join(', ')}) — агент завершил ход без ответа. Разреши действие во всплывашке или переформулируй запрос.`;
          else reply = '⚠ Агент завершил ход без текстового ответа. Повтори вопрос — контекст сохранён.';
        }
        resolve({ reply, sessionId: j.session_id || sessionId || null, cost: j.total_cost_usd ?? null, contextTokens });
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
          if (ev.type === 'assistant' && ev.message?.usage) {
            spentTokens += ev.message.usage.output_tokens || 0;
            try { onProgress?.(spentTokens); } catch { /* прогресс не критичен */ }
          } else if (ev.type === 'result') {
            resultEv = ev;
          }
        }
      });
    });
  },
};
