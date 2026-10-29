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

// `state-change` приходит пачками (движок пишет реестр часто), поэтому короткая пауза
// нужна: обход не должен запускаться на каждый чих файловой системы.
//
// Но минуты ожидания здесь были ошибкой. Остановка — это КОНЕЧНОЕ состояние: после неё
// движок больше ничего не пишет, ждать «тишины» не от чего, а конвейер всё это время
// стоит. Восемь секунд гасят пачку событий и не превращаются в ожидание.
//
// Платой за короткую паузу был бы дорогой обход на каждом чихе живого прогона (та же
// грабля, что убила карточку «Слоты запуска»), поэтому перед ним идёт дешёвый фильтр:
// пока ни один реестр не отмечен остановкой, полный список задач не читается вовсе.
const SETTLE_MS = 8 * 1000;

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

// Задача в списке обхода ровно в тех полях, по которым вотчер решает, брать ли её.
// Полную форму задачи знает сам поставщик списка.
interface WatchedTask {
  task?: unknown;
  readOnly?: unknown;
  daemonAlive?: unknown;
  stall?: {
    arbitrable?: unknown;
    node?: unknown;
    stop?: unknown;
    arbiter?: { verdict?: unknown; node?: unknown; stop?: unknown } | null;
    conversation?: { started?: boolean } | null;
    conversationHistory?: boolean;
  } | null;
}

// Заглушка ответа: общий `runArbitration` писался под HTTP, и вотчер подставляет
// ему тот же контракт, а не вторую ветку того же пути.
interface ArbitrationReply {
  code: () => ArbitrationReply;
  send: (body: unknown) => ArbitrationReply;
}

// Журнал сервера в том минимуме, который использует вотчер.
interface WatchLog {
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

export interface FactoryArbiterWatchDeps {
  sse: { subscribe: (fn: (name: string) => void) => () => void };
  prefs: { read: () => unknown };
  listTasks: () => Promise<readonly WatchedTask[] | null | undefined>;
  arbitrate: (taskId: string, reply: ArbitrationReply) => Promise<{
    resolved?: unknown;
    node?: unknown;
    conversationId?: string;
    completion?: Promise<void>;
  } | null>;
  hasStopped?: (() => Promise<unknown>) | null;
  log?: WatchLog;
}

export class FactoryArbiterWatch {
  private readonly sse: FactoryArbiterWatchDeps['sse'];

  private readonly prefs: FactoryArbiterWatchDeps['prefs'];

  private readonly listTasks: FactoryArbiterWatchDeps['listTasks'];

  // Дешёвая предпроверка: есть ли вообще остановленная задача. Полный список задач
  // читает журналы попыток и вердикты каждой — платить этим за каждое событие шины
  // живого прогона нельзя.
  private readonly hasStopped: (() => Promise<unknown>) | null;

  private readonly arbitrate: FactoryArbiterWatchDeps['arbitrate'];

  private readonly log: WatchLog;

  private unsubscribe: (() => void) | null = null;

  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private running = false;

  private readonly cooldown = new Map<string, number>();

  constructor({
    sse, prefs, listTasks, arbitrate, hasStopped = null, log = console,
  }: FactoryArbiterWatchDeps) {
    this.sse = sse;
    this.prefs = prefs;
    this.listTasks = listTasks;
    this.hasStopped = hasStopped;
    this.arbitrate = arbitrate;
    this.log = log;
  }

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.sse.subscribe((name: string) => {
      if (name === 'state-change') this.schedule();
    });
    this.sweepTimer = setInterval(() => this.schedule(), SWEEP_MS);
    this.sweepTimer.unref?.();

    // Задача, вставшая ДО подъёма сервера, шину не разбудит: остановка — конечное
    // состояние, после неё движок не пишет ни строки, а `fs.watch` заводится только
    // сейчас. Без стартового обхода такая задача ждала бы первого срабатывания редкой
    // страховки, то есть до пятнадцати минут поверх уже накопленного простоя — и ровно
    // в том случае, ради которого автоматический путь и заведён: ночная стоянка,
    // утренний рестарт машины, включённый арбитр и стоящий конвейер.
    this.schedule();
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
      this.tick().catch((err: unknown) => this.log?.warn?.({ err }, 'арбитр: обход не состоялся'));
    }, SETTLE_MS);
    this.settleTimer.unref?.();
  }

  /** Настройка читается на КАЖДОМ заходе: выключатель обязан действовать сразу. */
  enabled() {
    try {
      const prefs = this.prefs?.read() as { arbiter?: { auto?: unknown } } | null;
      return prefs?.arbiter?.auto === true;
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
      if (this.hasStopped && !await this.hasStopped()) return;

      const tasks = await this.listTasks();
      const now = Date.now();
      for (const task of tasks || []) {
        if (task?.readOnly || task?.daemonAlive) continue;
        // Тот же признак, что зажигает кнопку в карточке: считает его сервер одним
        // правилом вместе с гейтом арбитра. Своя копия сравнения с `no-progress`
        // разъехалась бы с ними при первом же расширении набора остановок.
        if (!task?.stall?.arbitrable) continue;
        if (task.stall.conversation?.started) {
          continue;
        }
        // Арбитр уже разбирал ЭТУ остановку и честно вернул решение человеку. Второй
        // заход не бесплатен и не безобиден: вход не изменился, а ответ у модели не
        // детерминирован. Замер 28.08.2026 (задача 8507, узел `build`, остановка `human`):
        // в 22:33 арбитр вернул решение человеку, в 23:42 после часового cooldown взял ту
        // же остановку снова и в 23:47 решил её САМ, пометив `deferred`, — то есть отменил
        // собственный вопрос и сдвинул курсор задачи, о которой человека только что
        // спросили. Плюс 6 мин 51 с живого opus-5 на max effort за каждый такой заход.
        //
        // Карточка привязана к попытке, поэтому новая попытка снимает запрет сама. Узел
        // снимает его тоже, но ТОЛЬКО когда известен с обеих сторон: человек мог вернуть
        // курсор, и маршрут встал уже в другом месте — это другая остановка, её разбирать
        // надо. Неизвестный узел трактуем как «та же остановка»: лишний запрет стоит
        // одного нажатия кнопки, лишний разбор — часа агента и чужого решения.
        const stall = task.stall;
        const decided = stall?.arbiter;
        const otherNode = Boolean(decided?.node && stall?.node
          && decided.node !== stall.node);

        if (!stall.conversationHistory && decided?.verdict === 'human'
          && decided.stop === stall?.stop
          && !otherNode) {
          continue;
        }

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
  async attempt(id: string) {
    // Взятие задачи в разбор обязано быть видно. Раньше вотчер писал строку только по
    // ИСХОДУ, поэтому вопрос «он вообще просыпался?» упирался в пустой журнал: молчание
    // одинаково означало и «кандидатов не было», и «разбор идёт прямо сейчас», и
    // «арбитр отдал решение человеку». Арбитраж занимает минуты живого агента — такой
    // ход не имеет права быть невидимым.
    this.log?.info?.({ task: id }, 'арбитр: беру остановку в разбор');
    let refusal: { error?: unknown } | null = null;
    const reply: ArbitrationReply = {
      code() { return this; },
      send(body: unknown) { refusal = body as { error?: unknown } | null; return this; },
    };
    let result: Awaited<ReturnType<FactoryArbiterWatchDeps['arbitrate']>> = null;

    try {
      result = await this.arbitrate(id, reply);

      if (result?.completion) {
        await result.completion;
      }
    } catch (err) {
      this.log?.warn?.({ err, task: id }, 'арбитр: разбор упал');
      this.cooldown.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      return 'failed';
    }
    if (result === null) {
      const code = String((refusal as { error?: unknown } | null)?.error || 'unknown');
      this.log?.info?.({ task: id, code }, 'арбитр: разбор не состоялся');
      this.cooldown.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      return PRE_MODEL_REFUSALS.has(code) ? 'cheap-skip' : 'failed';
    }
    if (result.conversationId) {
      this.cooldown.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      this.log?.info?.({ task: id }, 'арбитр: результат и состояние разбора сохранены в диалоге');

      return 'human';
    }
    if (!result.resolved) {
      // Решение о границе задачи. Оно принадлежит человеку, и повторять его нечем.
      // Карточку разбора сохранил сам `runArbitration` (`ArbiterCardsStore`), поэтому она
      // видна в остановке задачи; до 28.08.2026 здесь она просто отбрасывалась, и
      // автоматический разбор пропадал вместе с потраченным ходом живого агента.
      this.cooldown.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      this.log?.info?.({ task: id }, 'арбитр: решение о границе задачи отдано человеку');
      return 'human';
    }
    this.cooldown.delete(id);
    this.log?.info?.({ task: id, node: result.node }, 'арбитр: тупик снят, маршрут продолжен');
    return 'resolved';
  }
}
