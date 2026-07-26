// Исполнитель GPT (OpenAI Codex CLI).
// Установка: npm i -g @openai/codex && codex login — после этого провайдер оживает сам.
// Запуск неинтерактивный: `codex exec --json` (JSONL-события), резюме через
// `codex exec resume <thread_id>`. Песочница read-only: своей всплывашки разрешений
// у codex-exec нет, действия за пределами чтения не даём.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmLatest } from './_npm-latest.js';

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

  run({ config, message, cwd, model, effort, sessionId }) {
    const args = sessionId ? ['exec', 'resume', sessionId, '--json'] : ['exec', '--json'];
    args.push('--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd);
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(message);

    return new Promise((resolve, reject) => {
      const child = execFile(config.codexBin, args, { cwd, timeout: config.chatTimeoutMs || 3600000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          return reject(new Error('GPT-исполнитель не установлен: npm i -g @openai/codex && codex login'));
        }
        if (err && !stdout) return reject(new Error((stderr || err.message).slice(-600)));
        // JSONL-поток: собираем последний agent_message, thread_id и usage.
        let reply = '';
        let threadId = sessionId || null;
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
