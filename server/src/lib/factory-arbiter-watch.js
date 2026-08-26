// Автоматический разбор типизированных остановок конвейера.
//
// Кнопка снимает курьерскую работу, но не снимает главную цену. Замер по журналам всех
// попыток: медиана ожидания человека после типизированной остановки — 15 минут, а сумма
// 59.7 часа, и 53 часа из них дают ПЯТЬ ночных стоянок по 8–14 часов. Кнопку в это время
// никто не нажимает: человек спит, а стенд и слот заняты.
//
// Поэтому у арбитра есть автоматический путь. Он выключен по умолчанию (prefs
// `arbiter.auto`) и включается человеком, когда тот прочитал несколько решений и им верит.
//
// Что вотчер НЕ делает и почему:
//   - не заводит свой опрос состояния: он просыпается по уже существующему SSE
//     `state-change` (та же шина, что будит окна) и по редкой страховке;
//   - не решает, можно ли арбитрировать: это решает общий `runArbitration` — у него уже
//     есть проверка вида остановки, потолок арбитражей на попытку и граница задачи.
//     Вторая копия правил разошлась бы с первой;
//   - не повторяет отказ: у каждой задачи свой cooldown, иначе детерминированный отказ
//     (нет модели, нет рабочего дерева) крутился бы на каждом событии шины.

// `state-change` приходит пачками (движок пишет реестр часто), а арбитраж стоит минут и
// денег. Ждём тишины: важен не каждый чих, а то, что маршрут ВСТАЛ и стоит.
const SETTLE_MS = 60 * 1000;

// Страховка на случай, если остановка случилась без записи в state (или событие потерялось
// в момент рестарта). Редкая: обычный путь — это шина.
const SWEEP_MS = 15 * 60 * 1000;

// Задача, которую только что не удалось разобрать, не должна проверяться на каждом событии.
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

// Отказы, случившиеся ДО обращения к модели. Они ничего не стоили, поэтому обход идёт
// дальше: десять задач без выбранной модели — это десять дешёвых отказов, а не повод
// закончить обход на первой. Всё остальное (упавший ход, неразобранный ответ, отклонённый
// возврат) обошлось в минуты живого агента, и продолжать обход после такого нельзя:
// десять задач подряд сожгли бы час.
const PRE_MODEL_REFUSALS = new Set([
  'not_found',
  'legacy_task_read_only',
  'attempt_integrity_failed',
  'attempt_terminal',
  'ledger_unreadable',
  'not_arbitrable',
  'arc_unknown',
  'arbiter_budget_spent',
  'no_model',
  'registry_failed',
  'executor_unavailable',
  'arbiter_plan_unavailable',
  'unknown_model',
  'arbiter_workspace_unavailable',
]);

export class FactoryArbiterWatch {
  /**
   * @param {{
   *   sse: { subscribe: (fn: Function) => Function },
   *   prefs: { read: () => any },
   *   listTasks: () => Promise<Array<any>>,
   *   arbitrate: (taskId: string, reply: any) => Promise<any>,
   *   log?: any,
   * }} deps
   */
  constructor({
    sse, prefs, listTasks, arbitrate, log = console,
  }) {
    this.sse = sse;
    this.prefs = prefs;
    this.listTasks = listTasks;
    this.arbitrate = arbitrate;
    this.log = log;
    this.unsubscribe = null;
    this.settleTimer = null;
    this.sweepTimer = null;
    this.running = false;
    this.cooldown = new Map();
  }

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.sse.subscribe((name) => {
      if (name === 'state-change') this.schedule();
    });
    this.sweepTimer = setInterval(() => this.schedule(), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Ждём тишины на шине: остановка — это состояние, а не мгновение. */
  schedule() {
    if (!this.enabled() || this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.tick().catch((err) => this.log?.warn?.({ err }, 'арбитр: обход не состоялся'));
    }, SETTLE_MS);
    this.settleTimer.unref?.();
  }

  /** Настройка читается на КАЖДОМ заходе: выключатель обязан действовать сразу. */
  enabled() {
    try {
      return this.prefs?.read()?.arbiter?.auto === true;
    } catch {
      return false;
    }
  }

  /**
   * Один обход остановленных задач.
   *
   * Арбитраж последовательный и по одной задаче за обход: он занимает минуты живого
   * агента, и две параллельных попытки на одной машине спорят за исполнителя.
   */
  async tick() {
    if (!this.enabled() || this.running) return;
    this.running = true;
    try {
      const tasks = await this.listTasks();
      const now = Date.now();
      for (const task of tasks || []) {
        if (task?.readOnly || task?.daemonAlive) continue;
        if (task?.stall?.stop !== 'no-progress') continue;
        const id = String(task.task || '');
        if (!id) continue;
        const until = this.cooldown.get(id) || 0;
        if (until > now) continue;
        const outcome = await this.attempt(id);
        // Дальше по списку идём только после дешёвого отказа. Всё, что дошло до модели,
        // заканчивает обход: следующее событие шины разбудит заново.
        if (outcome !== 'cheap-skip') break;
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Один арбитраж. Ответ собирается в заглушку reply: общий `runArbitration` писался под
   * HTTP, и подсовывать ему другой контракт значило бы держать две ветки одного пути.
   */
  async attempt(id) {
    let refusal = null;
    const reply = {
      code() { return this; },
      send(body) { refusal = body; return this; },
    };
    let result = null;
    try {
      result = await this.arbitrate(id, reply);
    } catch (err) {
      this.log?.warn?.({ err, task: id }, 'арбитр: разбор упал');
      this.cooldown.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      return 'failed';
    }
    if (result === null) {
      const code = refusal?.error || 'unknown';
      this.log?.info?.({ task: id, code }, 'арбитр: разбор не состоялся');
      this.cooldown.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      return PRE_MODEL_REFUSALS.has(code) ? 'cheap-skip' : 'failed';
    }
    if (!result.resolved) {
      // Решение о границе задачи. Оно принадлежит человеку, и повторять его нечем:
      // карточка уже лежит в журнале сервера, а задача ждёт его на экране.
      this.cooldown.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      return 'human';
    }
    this.cooldown.delete(id);
    this.log?.info?.({ task: id, node: result.node }, 'арбитр: тупик снят, маршрут продолжен');
    return 'resolved';
  }
}
