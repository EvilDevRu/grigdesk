// B24Adapter — изоляция интеграции Битрикс24 от остального сервера.
// Строит локальный B24Client из кредов «Настроек» + СВОЙ cookie-файл (нет конфликта
// между процессами). Собирает полный DTO «Рабочего стола» из getTodayData + chartDataByPeriod.
import { B24Client } from '../lib/b24/b24-client.js';

export class B24Adapter {
  /** @param {{ credsStore: import('../lib/b24/creds-store.js').CredsStore, cookiePath: string }} opts */
  constructor({ credsStore, cookiePath }) {
    this.credsStore = credsStore;
    this.cookiePath = cookiePath;
    this._client = null;
    this._sig = null;
    this._chain = Promise.resolve(); // очередь: B24Client не потокобезопасен (общая сессия/куки)
  }

  /** Сериализует операции с клиентом — иначе конкурентные запросы рвут сессию («Client Error»). */
  _run(fn) {
    const r = this._chain.then(fn);
    this._chain = r.then(() => {}, () => {}); // цепочку не рвём на ошибке
    return r;
  }

  /** Ленивая сборка клиента; пересоздаёт, если креды сменились. Бросает, если не настроено. */
  client() {
    const creds = this.credsStore.read();
    if (!creds) throw new Error('B24 не настроен: заполните логин/пароль в Настройках.');
    const sig = `${creds.baseUrl}|${creds.login}`;
    if (!this._client || this._sig !== sig) {
      this._client = new B24Client({ ...creds, cookiePath: this.cookiePath });
      this._sig = sig;
    }
    return this._client;
  }

  /** Сбросить клиент (после смены кредов). */
  invalidate() {
    this._client = null;
    this._sig = null;
  }

  /** Проверка авторизации: логинится и возвращает { ok, userId } или { ok:false, error }. */
  async testAuth() {
    return this._run(async () => {
      try {
        const client = this.client();
        await client.ensureAuth();
        const userId = (await client.discoverUserId()) ?? null;
        return { ok: true, userId };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  /** Полный DTO «Рабочего стола»: все блоки + графики. */
  async getDashboard() { return this._run(() => this._getDashboard()); }

  async _getDashboard() {
    const client = this.client();
    const uid = (await client.discoverUserId()) ?? 0;
    const resp = await client.apiGet(
      `/local/ajax/dashboard.php?action=getTodayData&user_id=${uid}&project_id=0&show_all_tasks=1`,
    );
    const d = resp?.data ?? {};

    // Задачи маппим тестированным mapTask, добавляем timerStartedAt (в mapTask его нет).
    const mapList = (arr) => (arr ?? []).map((t) => ({
      ...client.mapTask(t, uid),
      timerStartedAt: t.timer_started_at ?? null,
    }));

    const salaryHtml = await (await client.raw('/salary/?project_id=0')).text();
    const charts = B24Adapter.parseCharts(salaryHtml);
    const month = await client.getMonthStats();

    return {
      userId: uid,
      today: d.todayData ?? null,
      prevDay: d.prevDayData ?? null,
      dynamics: d.dynamics ?? null,
      activeTimer: d.activeTimer ?? null,
      workedToday: d.workedTasks ?? d.worked_tasks ?? d.todayData?.worked_tasks ?? [],
      tasks: mapList(d.currentTasks),
      toReview: mapList(d.tasksToReview),
      created: mapList(d.createdTasks),
      accomplice: mapList(d.accompliceTasks),
      auditor: mapList(d.auditorTasks),
      month,
      charts,
    };
  }

  /** Детали одной задачи. */
  async taskDetail(taskId) { return this._run(() => this.client().taskDetails(taskId)); }

  /** Вложения + комментарии со страницы задачи (getTaskDetails их не отдаёт). */
  async taskPageData(taskId) { return this._run(() => this.client().taskPageData(taskId)); }

  // --- Действия (мутации). Все — через очередь (общая сессия). ---

  async createTask(opts) { return this._run(() => this.client().createTask(opts)); }
  async addComment(taskId, text) { return this._run(() => this.client().addComment(taskId, text)); }
  async timer(action, taskId) { return this._run(() => this.client().timer(action, taskId)); }
  async completeTask(taskId) { return this._run(() => this.client().completeTask(taskId)); }
  async renewTask(taskId) { return this._run(() => this.client().renewTask(taskId)); }
  async findUsers(query) { return this._run(() => this.client().findUsers(query)); }

  /**
   * Извлекает chartDataByPeriod (сбалансированный JSON-объект) из HTML /salary/.
   * Периоды day/week/month, серии hours/tasks/avg_time (+ *_dept — среднее по коллегам).
   */
  static parseCharts(html) {
    const at = html.indexOf('chartDataByPeriod');
    if (at < 0) return null;
    const start = html.indexOf('{', at);
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < html.length; i += 1) {
      const c = html[i];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(html.slice(start, i + 1)); }
          catch { return null; }
        }
      }
    }
    return null;
  }
}
