// Сервер владеет одной сессией Б24 и сериализует работу с её cookie и sessid.
// Читатели разделяют срок и работу, а локальный scope не ждёт занятую очередь.
import { createHash } from 'node:crypto';

import { B24Client } from '../lib/b24/client.ts';
import type { NewTask } from '../lib/b24/client.ts';
import type { CredsStore } from '../lib/b24/credsStore.ts';
import { B24ReadOperations } from '../lib/b24/readOperations.ts';
import type {
  B24ReadOperation,
  B24ReadOptions,
  B24ReadTrace,
} from '../lib/b24/readOperations.ts';

export interface B24AccountIdentity {
  baseUrl: string;
  userId: number;
}

interface AdapterOptions {
  credsStore: CredsStore;
  cookiePath: string;
  readTimeoutMs?: number;
  trace?: (event: B24ReadTrace) => void;
}

export class B24Adapter {
  readonly credsStore: CredsStore;
  readonly cookiePath: string;

  private _client: B24Client | null = null;
  private _sig: string | null = null;
  private _identity: B24AccountIdentity | null = null;
  private _chain: Promise<unknown> = Promise.resolve();
  private _readVersion = 0;
  private readonly _reads: B24ReadOperations;

  constructor({ credsStore, cookiePath, readTimeoutMs, trace }: AdapterOptions) {
    this.credsStore = credsStore;
    this.cookiePath = cookiePath;
    this._reads = new B24ReadOperations((fn) => this._run(fn), {
      timeoutMs: readTimeoutMs,
      trace,
    });
  }

  /**
   * Физическая очередь ждёт настоящее завершение операции, включая отменяемое чтение.
   * Ошибка снимает свой элемент, не разрешая конкурентный доступ к общей сессии.
   */
  private _run<Value>(fn: () => Promise<Value> | Value): Promise<Value> {
    const work = this._chain.then(fn);

    this._chain = work.then(() => undefined, () => undefined);

    return work;
  }

  /**
   * Мутация ставит границу объединения до своей постановки в физическую очередь.
   * Чтение после действия не присоединяется к снимку, созданному до этого действия.
   */
  private _mutate<Value>(fn: () => Promise<Value> | Value): Promise<Value> {
    this._readVersion += 1;

    return this._run(fn);
  }

  /**
   * Клиент и версия выбираются до объединения, поэтому credentials разделяют поколения.
   * Полный ключ остаётся только в памяти и никогда не попадает в диагностический журнал.
   */
  private _read<Value>(key: string, operation: B24ReadOperation,
    fn: (client: B24Client, signal: AbortSignal) => Promise<Value>,
    options: B24ReadOptions = {}): Promise<Value> {
    const client = this.client();
    const versioned = `${this._readVersion}:${key}`;

    return this._reads.read(versioned, operation, (signal) => fn(client, signal), options.signal);
  }

  /**
   * Полные credentials сравниваются только в памяти; cookie-файл разделён по порталу и логину.
   * Прежний общий файл не импортируется: чужая действующая сессия не подтверждает новый scope.
   */
  client(): B24Client {
    const creds = this.credsStore.read();

    if (!creds) {
      this.invalidate();

      throw new Error('B24 не настроен: заполните логин/пароль в Настройках.');
    }

    const sig = JSON.stringify([creds.baseUrl, creds.login, creds.password]);

    if (!this._client || this._sig !== sig) {
      this.invalidate();

      const account = createHash('sha256')
        .update(JSON.stringify([creds.baseUrl.replace(/\/+$/u, ''), creds.login]))
        .digest('hex');

      this._client = new B24Client({
        ...creds,
        cookiePath: `${this.cookiePath}.${account}`,
      });
      this._sig = sig;
    }

    return this._client;
  }

  /**
   * Смена учётной записи отменяет старые чтения до очистки локального scope.
   * Физическая очередь сохраняется, пока активная работа действительно не закончилась.
   */
  invalidate(): void {
    this._reads.invalidate();
    this._readVersion += 1;
    this._client = null;
    this._sig = null;
    this._identity = null;
  }

  /**
   * Проверка настройки не создаёт клиента и не обращается к порталу.
   * Её используют входящие перед чтением материалов и запуском модели.
   */
  isConfigured(): boolean {
    return this.credsStore.read() !== null;
  }

  /**
   * Проверка существования номера остаётся чтением той же серверной сессии.
   * Отсутствующая настройка возвращает unknown без сетевого обращения.
   */
  async probeTaskNumber(id: string): Promise<'exists' | 'absent' | 'unknown'> {
    if (!this.isConfigured()) {
      return 'unknown';
    }

    return this._read(`probe:${id}`, 'probe', (client) => client.probeTaskNumber(id));
  }

  /**
   * Проверенный scope текущих credentials не зависит от очереди операций портала.
   * Холодное определение объединяется; отменённый результат не восстанавливает старый кэш.
   */
  async accountIdentity(options: B24ReadOptions = {}): Promise<B24AccountIdentity | null> {
    this.client();
    options.signal?.throwIfAborted();

    if (this._identity) {
      return { ...this._identity };
    }

    const identity = await this._read('identity', 'identity', async (client, signal) => {
      if (this._identity) {
        return this._identity;
      }

      const userId = await client.discoverUserId();

      signal.throwIfAborted();

      if (!userId) {
        return null;
      }

      this._identity = { baseUrl: client.baseUrl, userId };

      return this._identity;
    }, options);

    return identity ? { ...identity } : null;
  }

  /**
   * Явная проверка входа сохраняет прежний результат и правила работы с авторизацией.
   * Она ставит границу объединения, поскольку может изменить сессию портала.
   */
  async testAuth(): Promise<{
    ok: boolean;
    userId?: number | null;
    error?: string;
  }> {
    return this._mutate(async () => {
      try {
        const client = this.client();

        await client.ensureAuth();

        const userId = (await client.discoverUserId()) ?? null;

        return { ok: true, userId };
      } catch (error) {
        return { ok: false, error: String((error as { message?: unknown } | null)?.message || error) };
      }
    });
  }

  /**
   * Все окна разделяют одно чтение доски текущей версии операций.
   * Подписчик может уйти независимо от других, не продлевая общий срок.
   */
  async getDashboard(options: B24ReadOptions = {}): Promise<Record<string, unknown>> {
    return this._read('dashboard', 'dashboard',
      (client, signal) => this._getDashboard(client, signal), options);
  }

  /**
   * Клиент фиксируется до постановки в очередь и не заменяется во время чтения.
   * Проверка signal перед публикацией identity отсекает результат старого аккаунта.
   */
  private async _getDashboard(client: B24Client, signal: AbortSignal): Promise<Record<string, unknown>> {
    const uid = (await client.discoverUserId()) ?? 0;

    signal.throwIfAborted();

    if (uid > 0) {
      this._identity = { baseUrl: client.baseUrl, userId: uid };
    }

    const resp = await client.apiGet(
      '/local/ajax/dashboard.php?action=getData'
        + `&user_id=${uid}&project_id=0&chart_period=day&show_all_tasks=1`,
    );
    const data = ((resp as { data?: unknown } | null)?.data ?? {}) as Record<string, unknown>;
    const mainData = (data.mainData ?? {}) as Record<string, unknown>;
    const mapList = (items: unknown) => ((items ?? []) as Record<string, unknown>[]).map((item) => ({
      ...client.mapTask(item, uid),
      timerStartedAt: item.timer_started_at ?? null,
    }));
    const salaryHtml = await (await client.raw('/salary/?project_id=0')).text();
    const charts = B24Adapter.parseCharts(salaryHtml);
    const month = await client.getMonthStats(mainData);

    signal.throwIfAborted();

    return {
      userId: uid,
      today: data.todayData ?? null,
      prevDay: data.prevDayData ?? null,
      dynamics: data.dynamics ?? null,
      activeTimer: data.activeTimer ?? null,
      workedToday: data.workedTasks
        ?? data.worked_tasks
        ?? (data.todayData as { worked_tasks?: unknown } | null)?.worked_tasks
        ?? [],
      tasks: mapList(data.currentTasks),
      toReview: mapList(data.tasksToReview),
      created: mapList(data.createdTasks),
      accomplice: mapList(data.accompliceTasks),
      auditor: mapList(data.auditorTasks),
      month,
      charts,
    };
  }

  async taskDetail(taskId: unknown, options: B24ReadOptions = {}): Promise<unknown> {
    return this._read(`task:${String(taskId)}`, 'task', (client) => client.taskDetails(taskId), options);
  }

  async taskPageData(taskId: unknown, options: B24ReadOptions = {}): Promise<unknown> {
    return this._read(`taskPage:${String(taskId)}`, 'taskPage',
      (client) => client.taskPageData(taskId), options);
  }

  async findUsers(query: unknown, options: B24ReadOptions = {}): Promise<unknown> {
    return this._read(`users:${String(query)}`, 'users', (client) => client.findUsers(query), options);
  }

  async listGroups(options: B24ReadOptions = {}): Promise<unknown> {
    return this._read('groups', 'groups', (client) => client.listGroups(), options);
  }

  async createTask(input: NewTask): Promise<unknown> {
    return this._mutate(() => this.client().createTask(input));
  }

  async updateTask(taskId: unknown, fields: unknown): Promise<unknown> {
    return this._mutate(() => this.client().updateTask(taskId, fields));
  }

  async addComment(taskId: unknown, text: unknown): Promise<unknown> {
    return this._mutate(() => this.client().addComment(taskId, text));
  }

  async timer(action: unknown, taskId: unknown): Promise<unknown> {
    return this._mutate(() => this.client().timer(action, taskId));
  }

  async completeTask(taskId: unknown): Promise<unknown> {
    return this._mutate(() => this.client().completeTask(taskId));
  }

  async renewTask(taskId: unknown): Promise<unknown> {
    return this._mutate(() => this.client().renewTask(taskId));
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
