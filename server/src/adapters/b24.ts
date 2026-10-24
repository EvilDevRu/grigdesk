// B24Adapter — изоляция интеграции Битрикс24 от остального сервера.
// Строит локальный B24Client из кредов «Настроек» + СВОЙ cookie-файл (нет конфликта
// между процессами). Собирает полный DTO «Рабочего стола» из getData + chartDataByPeriod.
import { B24Client } from '../lib/b24/client.ts';
import type { NewTask } from '../lib/b24/client.ts';
import type { CredsStore } from '../lib/b24/credsStore.ts';

// Кто мы на портале. Область пользовательских данных считается ИЗ этого, а не из
// того, что прислал браузер: иначе клиент мог бы попросить чужой набор.
export interface B24AccountIdentity {
  baseUrl: string;
  userId: number;
}

export class B24Adapter {
  readonly credsStore: CredsStore;

  readonly cookiePath: string;

  private _client: B24Client | null;

  private _sig: string | null;

  private _identity: B24AccountIdentity | null;

  // Очередь: B24Client не потокобезопасен — сессия и куки у него общие.
  private _chain: Promise<unknown>;

  constructor({ credsStore, cookiePath }: { credsStore: CredsStore; cookiePath: string }) {
    this.credsStore = credsStore;
    this.cookiePath = cookiePath;
    this._client = null;
    this._sig = null;
    this._identity = null;
    this._chain = Promise.resolve();
  }

  /** Сериализует операции с клиентом — иначе конкурентные запросы рвут сессию («Client Error»). */
  private _run<Value>(fn: () => Promise<Value> | Value): Promise<Value> {
    const r = this._chain.then(fn);

    // Цепочку не рвём на ошибке: один неудачный запрос не должен запирать очередь.
    this._chain = r.then(() => {}, () => {});

    return r;
  }

  /** Ленивая сборка клиента; пересоздаёт, если креды сменились. Бросает, если не настроено. */
  client(): B24Client {
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
  invalidate(): void {
    this._client = null;
    this._sig = null;
    this._identity = null;
  }

  /**
   * Дешёвый readiness gate без сети и без создания client-а.
   * Inbox проверяет его до чтения channel stores/model/materialize, чтобы при пустых
   * credentials вообще не касаться потенциально чувствительного текста обращений.
   */
  isConfigured(): boolean {
    return this.credsStore.read() !== null;
  }

  /**
   * Проверка номера пользуется той же очередью, что и остальные операции портала.
   * Отсутствие настройки не создаёт клиент и не делает сетевых запросов.
   */
  async probeTaskNumber(id: string): Promise<'exists' | 'absent' | 'unknown'> {
    if (!this.isConfigured()) {
      return 'unknown';
    }

    return this._run(() => this.client().probeTaskNumber(id));
  }

  /** Текущая область пользовательских B24-данных; кеш сбрасывается вместе с credentials. */
  async accountIdentity(): Promise<B24AccountIdentity | null> {
    return this._run(async () => {
      if (this._identity) return { ...this._identity };
      const client = this.client();
      const userId = await client.discoverUserId();
      if (!userId) return null;
      this._identity = { baseUrl: client.baseUrl, userId };
      return { ...this._identity };
    });
  }

  /** Проверка авторизации: логинится и возвращает { ok, userId } или { ok:false, error }. */
  async testAuth(): Promise<{ ok: boolean; userId?: number | null; error?: string }> {
    return this._run(async () => {
      try {
        const client = this.client();
        await client.ensureAuth();
        const userId = (await client.discoverUserId()) ?? null;
        return { ok: true, userId };
      } catch (err) {
        return { ok: false, error: String((err as { message?: unknown } | null)?.message || err) };
      }
    });
  }

  /** Полный DTO «Рабочего стола»: все блоки + графики. */
  async getDashboard(): Promise<Record<string, unknown>> {
    return this._run(() => this._getDashboard());
  }

  private async _getDashboard(): Promise<Record<string, unknown>> {
    const client = this.client();
    const uid = (await client.discoverUserId()) ?? 0;
    if (uid > 0) this._identity = { baseUrl: client.baseUrl, userId: uid };
    const resp = await client.apiGet(
      `/local/ajax/dashboard.php?action=getData&user_id=${uid}&project_id=0&chart_period=day&show_all_tasks=1`,
    );
    const d = ((resp as { data?: unknown } | null)?.data ?? {}) as Record<string, unknown>;
    const mainData = (d.mainData ?? {}) as Record<string, unknown>;

    // Задачи маппим тестированным mapTask, добавляем timerStartedAt (в mapTask его нет).
    const mapList = (arr: unknown) => ((arr ?? []) as Record<string, unknown>[]).map((t) => ({
      ...client.mapTask(t, uid),
      timerStartedAt: t.timer_started_at ?? null,
    }));

    const salaryHtml = await (await client.raw('/salary/?project_id=0')).text();
    const charts = B24Adapter.parseCharts(salaryHtml);
    const month = await client.getMonthStats(mainData);

    return {
      userId: uid,
      today: d.todayData ?? null,
      prevDay: d.prevDayData ?? null,
      dynamics: d.dynamics ?? null,
      activeTimer: d.activeTimer ?? null,
      workedToday: d.workedTasks
        ?? d.worked_tasks
        ?? (d.todayData as { worked_tasks?: unknown } | null)?.worked_tasks
        ?? [],
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
  async taskDetail(taskId: unknown): Promise<unknown> {
    return this._run(() => this.client().taskDetails(taskId));
  }

  /** Вложения + комментарии со страницы задачи (getTaskDetails их не отдаёт). */
  async taskPageData(taskId: unknown): Promise<unknown> {
    return this._run(() => this.client().taskPageData(taskId));
  }

  // --- Действия (мутации). Все — через очередь (общая сессия). ---

  async createTask(opts: NewTask): Promise<unknown> {
    return this._run(() => this.client().createTask(opts));
  }

  async updateTask(taskId: unknown, fields: unknown): Promise<unknown> {
    return this._run(() => this.client().updateTask(taskId, fields));
  }

  async addComment(taskId: unknown, text: unknown): Promise<unknown> {
    return this._run(() => this.client().addComment(taskId, text));
  }

  async timer(action: unknown, taskId: unknown): Promise<unknown> {
    return this._run(() => this.client().timer(action, taskId));
  }

  async completeTask(taskId: unknown): Promise<unknown> {
    return this._run(() => this.client().completeTask(taskId));
  }

  async renewTask(taskId: unknown): Promise<unknown> {
    return this._run(() => this.client().renewTask(taskId));
  }

  async findUsers(query: unknown): Promise<unknown> {
    return this._run(() => this.client().findUsers(query));
  }

  async listGroups(): Promise<unknown> {
    return this._run(() => this.client().listGroups());
  }

  /**
   * Извлекает chartDataByPeriod (сбалансированный JSON-объект) из HTML /salary/.
   * Периоды day/week/month, серии hours/tasks/avg_time (+ *_dept — среднее по коллегам).
   */
  static parseCharts(html: string): unknown {
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
