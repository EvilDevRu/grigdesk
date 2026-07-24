// Триаж задач: очередь + одиночный headless-запуск claude на задачу (read-only разведка
// кода, без стенда). Агент сам пишет результат в каталог анализа (t<ID>.analysis.json +
// t<ID>.md), раннер валидирует и обогащает (SHA репозиториев, стоимость, время).
// Очередь in-process (конкуренция 1): анализ идёт минуты, при рестарте сервера
// незавершённые помечаются failed — кнопка «Оценить» запускает заново.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadTriageProfile } from './profile.js';
import { buildTriagePrompt } from './prompt.js';
import { refreshRepos } from '../git-refresh.js';

export class Analyzer {
  /**
   * @param {{config: object, claudeAuth: object|null, b24: object, factoryState: object, log: object}} opts
   */
  constructor({ config, claudeAuth, b24, factoryState, prefs, log }) {
    this.config = config;
    this.claudeAuth = claudeAuth;
    this.b24 = b24;
    this.factoryState = factoryState;
    this.prefs = prefs;
    this.log = log;
    this.dir = config.analysisDir;
    this._queue = [];
    this._jobs = new Map(); // id → 'queued' | 'running'
    this._profile = null;   // кеш профиля триажа
    this._ready = this._init();
  }

  async _init() {
    await fs.mkdir(this.dir, { recursive: true });
    // Осиротевшие .tmp атомарной записи (умерли между write и rename) — мусор.
    for (const f of await fs.readdir(this.dir)) {
      if (f.endsWith('.json.tmp')) await fs.rm(path.join(this.dir, f), { force: true }).catch(() => {});
    }
    await this._sweepOrphans();
  }

  /**
   * Незавершённые статусы прошлой жизни сервера. Агент — отдельный процесс: рестарт
   * сервера его не убивает, и результат он мог дописать. Файл анализа свежее старта
   * прогона → done (без обогащения), иначе:
   *   • queued  → ВОССТАНАВЛИВАЕМ в очередь (задачи ставили осознанно, рестарт
   *     сервера не повод терять их и заставлять перезапускать 70 штук руками);
   *   • running → interrupted (агент реально прерван — перезапуск вручную из топбара).
   */
  async _sweepOrphans() {
    const requeue = [];
    for (const f of await fs.readdir(this.dir)) {
      if (!/^t\d+\.status\.json$/.test(f)) continue;
      const p = path.join(this.dir, f);
      try {
        const st = JSON.parse(await fs.readFile(p, 'utf8'));
        if (st.state !== 'queued' && st.state !== 'running') continue;
        const jsonStat = await fs.stat(this._paths(st.task).json).catch(() => null);
        if (jsonStat && st.startedAt && jsonStat.mtimeMs > st.startedAt) {
          await this._writeStatus(st.task, { ...st, state: 'done', note: 'дописан агентом после рестарта сервера', finishedAt: Date.now() });
        } else if (st.state === 'queued') {
          requeue.push({ id: String(st.task), at: st.queuedAt || 0 });
        } else {
          await this._writeStatus(st.task, {
            ...st,
            state: 'interrupted',
            error: 'агент прерван рестартом сервера',
            finishedAt: Date.now(),
          });
        }
      } catch { /* битый статус не мешает остальным */ }
    }
    if (requeue.length) {
      requeue.sort((a, b) => a.at - b.at);
      for (const r of requeue) {
        if (this._jobs.has(r.id)) continue;
        this._jobs.set(r.id, 'queued');
        this._queue.push(r.id);
      }
      this.log?.info({ count: requeue.length }, 'триаж: очередь восстановлена после рестарта');
      this._pump();
    }
  }

  _paths(id) {
    return {
      json: path.join(this.dir, `t${id}.analysis.json`),
      note: path.join(this.dir, `t${id}.md`),
      status: path.join(this.dir, `t${id}.status.json`),
      log: path.join(this.dir, `t${id}.log`),
    };
  }

  async _writeStatus(id, st) {
    const p = this._paths(id).status;
    await fs.writeFile(p + '.tmp', JSON.stringify({ task: Number(id), ...st }, null, 2));
    await fs.rename(p + '.tmp', p);
  }

  async _readJson(p) {
    try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
  }

  async profile() {
    if (!this._profile) {
      const name = this.config.factoryProfile || (await this.factoryState.primaryProfile().catch(() => '')) || '';
      this._profile = await loadTriageProfile(this.config.factoryHome, name);
    }
    return this._profile;
  }

  /** Сводка по всем анализам: оценки + статусы (для бейджей доски). */
  async list() {
    await this._ready;
    const byTask = new Map();
    for (const f of await fs.readdir(this.dir)) {
      const m = f.match(/^t(\d+)\.(analysis|status)\.json$/);
      if (!m) continue;
      const id = m[1];
      const row = byTask.get(id) || { task: Number(id) };
      const data = await this._readJson(path.join(this.dir, f));
      if (data) {
        if (m[2] === 'analysis') row.analysis = data;
        else row.status = data;
      }
      byTask.set(id, row);
    }
    // Живые статусы очереди поверх файлов (queued ещё не имеет файла).
    for (const [id, state] of this._jobs) {
      const row = byTask.get(String(id)) || { task: Number(id) };
      row.status = { ...(row.status || {}), task: Number(id), state };
      byTask.set(String(id), row);
    }
    return [...byTask.values()].sort((a, b) => b.task - a.task);
  }

  /** Деталь одного анализа: оценки + разведнота + статус + протухание. */
  async get(id) {
    await this._ready;
    const p = this._paths(id);
    const [analysis, status] = await Promise.all([this._readJson(p.json), this._readJson(p.status)]);
    let note = null;
    try { note = await fs.readFile(p.note, 'utf8'); } catch { /* разведноты может не быть */ }
    const live = this._jobs.get(String(id));
    return {
      task: Number(id),
      analysis,
      note,
      stale: analysis ? await this._staleFiles(analysis) : null,
      status: live ? { ...(status || {}), task: Number(id), state: live } : status,
    };
  }

  /**
   * Протухание анализа: какие из его files[] изменились в репо с момента оценки.
   * Движение master само по себе не сигнал (коммиты летят часто) — сигнал только
   * пересечение диффа с файлами, на которые опирается оценка.
   */
  async _staleFiles(analysis) {
    const out = [];
    for (const [key, r] of Object.entries(analysis.repos || {})) {
      if (!r?.sha || !r?.dir) continue;
      const changed = await this._changedSince(r.dir, r.sha);
      if (!changed) continue;
      const mine = (analysis.files || [])
        .filter((f) => f.startsWith(key + ':'))
        .map((f) => f.slice(key.length + 1));
      out.push(...mine.filter((f) => changed.has(f)).map((f) => `${key}:${f}`));
    }
    return out;
  }

  /** Изменённые файлы sha..HEAD с кешем: анализы одной волны делят один SHA. */
  async _changedSince(dir, sha) {
    const key = `${dir}|${sha}`;
    const hit = this._diffCache?.get(key);
    if (hit && Date.now() - hit.at < 120000) return hit.files;
    const files = await new Promise((resolve) => {
      execFile('git', ['-C', dir, 'diff', '--name-only', `${sha}..HEAD`], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
        (err, out) => resolve(err ? null : new Set(out.split('\n').filter(Boolean))));
    });
    this._diffCache = this._diffCache || new Map();
    this._diffCache.set(key, { at: Date.now(), files });
    return files;
  }

  /** Скрыть прерванный/упавший статус (решение «не перезапускать»). Живые задачи не трогаем. */
  async dismiss(id) {
    await this._ready;
    id = String(id);
    if (this._jobs.has(id)) return { outcome: 'busy' };
    await fs.rm(this._paths(id).status, { force: true });
    return { outcome: 'dismissed' };
  }

  /** Поставить задачу в очередь анализа. Дедуп: уже queued/running → не дублируем. */
  async enqueue(id) {
    await this._ready;
    id = String(id);
    if (this._jobs.has(id)) return { outcome: 'already_' + this._jobs.get(id) };
    this._jobs.set(id, 'queued');
    this._queue.push(id);
    await this._writeStatus(id, { state: 'queued', queuedAt: Date.now() });
    this._pump();
    return { outcome: 'queued', position: this._queue.length };
  }

  _pump() {
    // Конкуренция настраиваемая: очередь в 70 задач при одном воркере — это часы.
    const max = Math.max(1, Number(this.config.analysisConcurrency) || 1);
    this._active = this._active || 0;
    while (this._active < max && this._queue.length) {
      const id = this._queue.shift();
      this._active += 1;
      this.analyze(id)
        .catch((e) => this.log?.error({ task: id, err: e.message }, 'триаж упал вне раннера'))
        .finally(() => {
          this._jobs.delete(id);
          this._active -= 1;
          this._pump();
        });
    }
  }

  /** Полный цикл анализа одной задачи (используется очередью и CLI). */
  async analyze(id) {
    await this._ready;
    id = String(id);
    const p = this._paths(id);
    const startedAt = Date.now();
    this._jobs.set(id, 'running');
    await this._writeStatus(id, { state: 'running', startedAt });
    try {
      const profile = await this.profile();
      // Оцениваем свежий код: перед запуском подтягиваем изменения (правило кокпита,
      // выключается в настройках). Безопасно: ff-only и только чистый master.
      let gitRefresh = null;
      // Не чаще раза в 10 минут: волна из десятков задач не должна дёргать pull
      // на каждую (и параллельные воркеры не гоняют git по одному репо разом).
      if (this.prefs?.read().gitRefreshBeforeRun
          && (!this._lastRefreshAt || Date.now() - this._lastRefreshAt > 10 * 60_000)) {
        this._lastRefreshAt = Date.now();
        gitRefresh = await refreshRepos(profile.repos);
        this.log?.info({ task: id, gitRefresh }, 'репозитории обновлены перед триажем');
      }
      this._gitRefresh = gitRefresh;
      const ticket = await this._fetchTicket(id);
      const prompt = buildTriagePrompt({
        task: id,
        title: ticket.title,
        description: ticket.description,
        comments: ticket.comments,
        profile,
        jsonPath: p.json,
        notePath: p.note,
      });
      // Старый результат убираем, чтобы не принять его за свежий при молчании агента.
      await fs.rm(p.json, { force: true });
      const run = await this._runClaude(id, prompt, profile);
      const analysis = await this._readJson(p.json);
      if (!analysis) {
        throw new Error(`агент не записал валидный ${path.basename(p.json)}: ${run.tail}`);
      }
      await this._enrich(p.json, analysis, { ticket, profile, run, startedAt });
      await this._writeStatus(id, { state: 'done', startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt });
      this.log?.info({ task: id, ms: Date.now() - startedAt, cost: run.costUsd }, 'триаж готов');
      return { ok: true };
    } catch (e) {
      await this._writeStatus(id, { state: 'failed', startedAt, finishedAt: Date.now(), error: String(e.message || e).slice(0, 600) });
      this.log?.warn({ task: id, err: e.message }, 'триаж упал');
      return { ok: false, error: e.message };
    }
  }

  /** Тикет из B24: заголовок + описание + несистемные комментарии. Комментарии — best effort. */
  async _fetchTicket(id) {
    const detail = await this.b24.taskDetail(id);
    let comments = [];
    try {
      const page = await this.b24.taskPageData(id);
      comments = (page.comments || []).filter((c) => !c.isSystem && c.text);
    } catch (e) {
      this.log?.warn({ task: id, err: e.message }, 'комментарии задачи не получены — триаж без них');
    }
    return {
      title: detail?.title || `Задача ${id}`,
      description: htmlToText(detail?.description || ''),
      comments,
    };
  }

  /** Allow/deny для агента: читать можно всё, писать — только в каталог анализа. */
  async _writeSettings(profile) {
    const allow = [
      'Read(//**)',
      `Write(${this.dir}/**)`, `Edit(${this.dir}/**)`,
      'Bash(git:*)', 'Bash(git -C:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(ls:*)', 'Bash(cat:*)',
      'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(find:*)', 'Bash(sed:*)', 'Bash(awk:*)',
    ];
    const deny = [];
    for (const d of profile.dirs) {
      deny.push(`Write(${d}/**)`, `Edit(${d}/**)`, `NotebookEdit(${d}/**)`);
    }
    const f = path.join(this.dir, 'agent-settings.json');
    await fs.writeFile(f, JSON.stringify({ permissions: { allow, deny } }, null, 2));
    return f;
  }

  async _runClaude(id, prompt, profile) {
    const p = this._paths(id);
    const settings = await this._writeSettings(profile);
    const args = [
      '-p', prompt,
      '--model', this.config.analysisModel,
      '--settings', settings,
      '--permission-mode', 'acceptEdits',
      '--output-format', 'json',
      '--add-dir', this.dir,
    ];
    for (const d of profile.dirs) args.push('--add-dir', d);
    const cwd = profile.cwd || this.config.factoryHome;
    const env = this.claudeAuth ? this.claudeAuth.env() : process.env;
    return new Promise((resolve, reject) => {
      execFile(this.config.claudeBin, args, {
        cwd, env, timeout: this.config.analysisTimeoutMs, maxBuffer: 32 * 1024 * 1024,
      }, async (err, stdout, stderr) => {
        // Сырой вывод — в лог-файл: единственный источник при разборе «агент промолчал».
        await fs.writeFile(p.log, `--- stdout ---\n${stdout || ''}\n--- stderr ---\n${stderr || ''}`).catch(() => {});
        if (err && !stdout) {
          return reject(new Error(`claude не отработал: ${(stderr || err.message).slice(-400)}`));
        }
        let j = {};
        try { j = JSON.parse(stdout); } catch { /* результат берём из файлов агента */ }
        resolve({
          costUsd: j.total_cost_usd ?? null,
          contextTokens: (j.usage?.input_tokens || 0) + (j.usage?.cache_read_input_tokens || 0) + (j.usage?.cache_creation_input_tokens || 0),
          tail: String(j.result || stderr || '').slice(-300),
        });
      });
    });
  }

  /** Дописывает в analysis.json то, что агенту знать неоткуда: SHA репо, стоимость, время. */
  async _enrich(jsonPath, analysis, { ticket, profile, run, startedAt }) {
    const repos = {};
    for (const r of profile.repos) {
      repos[r.key] = { dir: r.dir, sha: await gitSha(r.dir) };
    }
    const enriched = {
      ...analysis,
      title: ticket.title,
      generated_at: new Date().toISOString(),
      repos,
      meta: {
        model: this.config.analysisModel,
        duration_ms: Date.now() - startedAt,
        cost_usd: run.costUsd,
        context_tokens: run.contextTokens,
        git_refresh: this._gitRefresh,
      },
    };
    await fs.writeFile(jsonPath, JSON.stringify(enriched, null, 2));
  }
}

function gitSha(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 5000 }, (err, out) => {
      resolve(err ? null : out.trim());
    });
  });
}

/** Описание задачи приходит HTML'ом Битрикса — сводим к тексту для промпта. */
function htmlToText(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
