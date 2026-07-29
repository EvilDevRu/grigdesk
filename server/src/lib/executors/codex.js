// Исполнитель GPT (OpenAI Codex CLI).
// Установка: npm i -g @openai/codex && codex login — после этого провайдер оживает сам.
// Запуск неинтерактивный: `codex exec --json` (JSONL-события), резюме через
// `codex exec resume <thread_id>`. Песочница read-only: своей всплывашки разрешений
// у codex-exec нет, действия за пределами чтения не даём.
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { npmLatest } from './_npm-latest.js';

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
  if (!bars.length) {
    return {
      state: 'unavailable',
      bars: [],
      message: 'OpenAI не вернул данные о лимитах Codex.',
      action: null,
    };
  }
  return { state: 'ok', bars, message: '', action: null };
}

/**
 * Одноразовый read-only JSON-RPC клиент. Он не создаёт thread/turn и не вызывает
 * модель: поднимает `codex app-server`, читает только лимиты аккаунта и завершает
 * именно запущенный им дочерний процесс.
 */
export function readCodexRateLimits(bin, {
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
        send({ method: 'account/rateLimits/read', id: 2 });
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

export default {
  id: 'codex',
  name: 'GPT (Codex)',
  vendor: 'OpenAI',
  color: '#10a37f',
  order: 2,
  install: 'npm i -g @openai/codex && codex login',

  bin(config) { return config.codexBin; },

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

  /**
   * Живой список моделей OpenAI (/v1/models) — новые GPT появятся сами.
   * Нужен OPENAI_API_KEY в окружении (OAuth-токен codex для platform-API не подходит).
   * Фильтруем не-чатовые модели (audio/realtime/tts и пр.).
   */
  async discoverModels() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.data || [])
      .filter((m) => /^gpt-/.test(m.id) && !/(audio|realtime|image|tts|transcribe|search|embed|moderation)/.test(m.id))
      .map((m) => ({ id: m.id, name: m.id, createdAt: m.created ? new Date(m.created * 1000).toISOString() : '' }));
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
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', context: 400000, tier: 85, efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', context: 400000, tier: 70, efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', context: 400000, tier: 40, efforts: ['low', 'medium', 'high'] },
    ];
  },

  run({ config, message, cwd, model, effort, sessionId, signal }) {
    const args = sessionId ? ['exec', 'resume', sessionId, '--json'] : ['exec', '--json'];
    args.push('--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd);
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(message);

    return new Promise((resolve, reject) => {
      const child = execFile(config.codexBin, args, {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        signal,
      }, (err, stdout, stderr) => {
        // Даже оборванный первый ход успевает напечатать thread.started. Сохраняем id:
        // следующий вопрос сможет продолжить тот же разговор после кнопки «стоп».
        let threadId = sessionId || null;
        for (const line of (stdout || '').split('\n')) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try {
            const e = JSON.parse(t);
            if (e.type === 'thread.started' && e.thread_id) threadId = e.thread_id;
          } catch { /* неполная последняя JSONL-строка */ }
        }
        if (err?.code === 'ABORT_ERR' || signal?.aborted) {
          const stopped = new Error('Ход остановлен.');
          stopped.stopped = true;
          stopped.steps = [];
          stopped.sessionId = threadId;
          return reject(stopped);
        }
        if (err && err.code === 'ENOENT') {
          return reject(new Error('GPT-исполнитель не установлен: npm i -g @openai/codex && codex login'));
        }
        if (err && !stdout) return reject(new Error((stderr || err.message).slice(-600)));
        // JSONL-поток: собираем последний agent_message, thread_id и usage.
        let reply = '';
        let contextTokens = 0;
        for (const line of (stdout || '').split('\n')) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          let e;
          try { e = JSON.parse(t); } catch { continue; }
          if (e.type === 'thread.started' && e.thread_id) threadId = e.thread_id;
          if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) reply = e.item.text;
          if (e.type === 'turn.completed' && e.usage) {
            contextTokens = (e.usage.input_tokens || 0) + (e.usage.cached_input_tokens || 0);
          }
        }
        if (!reply) return reject(new Error(`codex не вернул ответ: ${(stderr || stdout || '').slice(-300)}`));
        resolve({ reply, sessionId: threadId, cost: null, contextTokens });
      });
      // stdin не используем — закрываем сразу (codex exec иначе может ждать ввода).
      child.stdin?.end();
    });
  },
};
