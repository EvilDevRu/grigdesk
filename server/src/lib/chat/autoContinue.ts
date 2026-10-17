// Петля автопродолжения упавшего хода. Здесь нет знания о вендорах и HTTP: решение
// принимается по результату адаптера (`deliveryFailure` + явный `turnRecovery`), вид
// сбоя называет реестр, а всё, что касается чата (очередь, публикация, подготовка),
// приходит колбэками. Автоматика отправляет ТОЛЬКО просьбу продолжить: исходный
// запрос не повторяется ни при каком значении признаков.
import type { ChatStep } from './streamSteps.ts';
import type {
  TurnFailureKind,
  TurnFailureRule,
  TurnFailureSignal,
  TurnRecovery,
} from './turnFailures.ts';

import { cleanRunnerFailureMessage } from '../runnerFailure.ts';
import {
  AUTO_CONTINUE_MAX_PER_TURN,
  TURN_FAILURE_LABELS,
  autoContinueBudget,
  autoContinueDelay,
  classifyTurnFailure,
} from './turnFailures.ts';

// Просьба продолжить: единственное сообщение автоматики. Она просит сверить сделанное,
// потому что отсутствие шагов не доказывает отсутствие внешних эффектов.
export const AUTO_CONTINUE_PROMPT = 'Предыдущая попытка завершилась временным сбоем. '
  + 'Cockpit продолжает этот ход автоматически. Сверь, что уже сделано и как завершились '
  + 'инструменты. Не повторяй выполненные действия. Продолжай с места остановки и доведи '
  + 'исходную задачу до конца.';

export type ContinueCancel = 'aborted' | 'yielded';
export type ContinueWait = 'elapsed' | ContinueCancel;
export type AutoContinueOutcome = 'recovered' | 'exhausted' | 'not_continuable'
  | 'not_resumable' | 'disabled' | 'yielded';

export interface ContinueWaitScope {
  wait(ms: number): Promise<ContinueWait>;
  status(): ContinueCancel | null;
  cancel(reason: ContinueCancel): void;
  dispose(): void;
}

export interface ContinueGate {
  open(chatKey: string, signal?: AbortSignal | null): ContinueWaitScope;
  notifyQueued(chatKey: string): void;
}

export interface ContinueSummary {
  steps: ChatStep[];
  cost: number | null;
  continued: number;
}

// Минимум результата адаптера, который нужен петле. Ядро чата передаёт сюда свой
// ExecutorRunResult: он шире, и лишние поля просто не читаются. Поля объявлены точно
// теми же типами, что у ExecutorRunResult, иначе расширенный результат не подошёл бы.
export interface ContinueRunResult {
  reply?: unknown;
  sessionId?: string | null;
  steps?: ChatStep[];
  cost?: unknown;
  stopped?: unknown;
  deliveryFailure?: boolean;
  sessionReset?: unknown;
  sessionResetFailed?: unknown;
  turnFailure?: TurnFailureSignal;
  turnRecovery?: TurnRecovery;
  [field: string]: unknown;
}

export interface AutoContinueOptions {
  isEnabled: () => boolean;
  signal?: AbortSignal | null;
  rules?: readonly TurnFailureRule[] | null;
  delaysMs?: Partial<Record<ContinuableKindKey, readonly number[]>>;
  maxContinuations?: number;
  continueMessage: string;
  run: (input: { message: string; sessionId: string }) => Promise<ContinueRunResult>;
  attemptSteps: () => readonly ChatStep[];
  openWait: () => ContinueWaitScope;
  hasQueued: () => boolean;
  beforeWait: () => Promise<void>;
  publishNote: (step: ChatStep) => void;
  onSummary: (summary: ContinueSummary) => void;
  log?: { warn: (fields: Record<string, unknown>, message: string) => void };
}

type ContinuableKindKey = 'rate_limited' | 'overloaded' | 'server_error' | 'network';

export type AutoContinueResult = ContinueRunResult & {
  failureKind?: TurnFailureKind | 'unknown';
  autoContinued?: number;
  autoContinueOutcome?: AutoContinueOutcome;
};

// Таймеры области отмены: в продакшене штатные, в тестах — ручные, без реального ожидания.
interface ContinueScheduler {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export interface ContinueGateOptions {
  scheduler?: ContinueScheduler;
}

// Ошибка остановки: у неё сохраняются накопленные шаги, стоимость и сессия, чтобы
// ядро отдало человеку ту же ленту, что он видел живьём.
interface StoppedFailure extends Error {
  stopped?: boolean;
  steps?: ChatStep[];
  cost?: number | null;
  autoContinued?: number;
  sessionId?: string | null;
  [field: string]: unknown;
}

/**
 * Область отмены на один чат. Запись создаётся СИНХРОННО, до первого await подготовки:
 * сообщение человека, пришедшее в этом окне, обязано отменить автопродолжение, а не
 * потеряться. Слушатель AbortSignal и запись карты живут до dispose — даже после того,
 * как таймер истёк, потому что фактический вызов попытки ещё впереди.
 */
export function createContinueGate({ scheduler }: ContinueGateOptions = {}): ContinueGate {
  const timers: ContinueScheduler = scheduler || {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  const open = new Map<string, ContinueWaitScope>();

  /**
 * Область отмены одного чата: состояние отмены, слушатель сигнала и таймер паузы.
 * Отмена sticky — пришедшая один раз, она видна через status() до самого dispose.
 */
function createScope(chatKey: string, signal?: AbortSignal | null): ContinueWaitScope {
    let cancelReason: ContinueCancel | null = null;
    // Отдельная память об истёкшей паузе: status() по контракту сообщает только отмену,
    // но после dispose решение о продолжении всё ещё читается как «время вышло».
    let waitElapsed = false;
    let timer: unknown = null;
    let finishWait: ((value: ContinueWait) => void) | null = null;
    let disposed = false;

    const onAbort = () => {
      cancelReason = 'aborted';
      settle();
    };

    // Отмена разрешает уже начатое ожидание. Поздний вызов после elapsed безвреден:
    // резолвер снят, а решение всё равно читается через status().
    function settle(): void {
      if (!finishWait) {
        return;
      }

      const done = finishWait;

      finishWait = null;

      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }

      waitElapsed = !cancelReason;
      done(cancelReason || 'elapsed');
    }

    if (signal) {
      if (signal.aborted) {
        cancelReason = 'aborted';
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const scope = {
      wait(ms: number): Promise<ContinueWait> {
        if (cancelReason) {
          return Promise.resolve(cancelReason);
        }

        return new Promise<ContinueWait>((resolve) => {
          finishWait = resolve;
          timer = timers.setTimeout(settle, ms);
        });
      },
      status: () => cancelReason,
      // Признак истёкшей паузы нужен тестам после dispose; в контракте его нет.
      elapsed: () => waitElapsed,
      cancel(reason: ContinueCancel): void {
        // Остановка приоритетнее уступки очереди: «Стоп» уже принят человеком.
        if (cancelReason === 'aborted') {
          return;
        }

        cancelReason = reason;
        settle();
      },
      /**
       * Идемпотентно снимает свой таймер, слушатель и только свою запись карты.
       * Незавершённое ожидание получает остановку и не зависает.
       */
      dispose(): void {
        if (disposed) {
          return;
        }

        disposed = true;
        // Истёкшее ожидание обязано быть видно и после снятия записи: решение о
        // продолжении принимается уже после того, как таймер отработал.
        if (cancelReason === null && finishWait === null && timer === null) {
          waitElapsed = true;
        }

        if (timer !== null) {
          timers.clearTimeout(timer);
          timer = null;
        }

        signal?.removeEventListener('abort', onAbort);

        // Ожидание не зависает: незавершённая попытка получает остановку.
        if (finishWait) {
          cancelReason = cancelReason || 'aborted';
          settle();
        }

        if (open.get(chatKey) === scope) {
          open.delete(chatKey);
        }
      },
    };

    return scope as ContinueWaitScope;
  }

  return {
    /**
     * Открывает область СИНХРОННО, до первого await подготовки: сообщение человека,
     * пришедшее в этом окне, обязано отменить автопродолжение, а не потеряться.
     * Повторный open того же чата — ошибка инварианта, а не молчаливая замена записи.
     */
    open(chatKey: string, signal?: AbortSignal | null): ContinueWaitScope {
      if (open.has(chatKey)) {
        throw new Error(`Область отмены чата ${chatKey} уже открыта: повторный open запрещён`);
      }

      const scope = createScope(chatKey, signal);

      open.set(chatKey, scope);

      return scope;
    },
    notifyQueued(chatKey: string): void {
      open.get(chatKey)?.cancel('yielded');
    },
  };
}

function costOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Сумма известных расходов: неизвестное слагаемое не обнуляет известное, но и не
// позволяет выдать частичную сумму за полный расход.
function addCost(left: number | null, right: unknown): number | null {
  const known = costOf(right);

  if (left === null) {
    return known;
  }

  if (known === null) {
    return left;
  }

  return left + known;
}

function stepsOf(value: unknown): ChatStep[] {
  return Array.isArray(value) ? (value as ChatStep[]) : [];
}

// Пауза словами: меньше минуты — секунды (минимум одна), иначе округлённые минуты.
function humanDelay(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));

  return seconds < 60 ? `${seconds} с` : `${Math.round(seconds / 60)} мин`;
}

/**
 * Текст заметки о паузе. Номер — ПЛАНИРУЕМОГО продолжения в текущей серии; сколько
 * продолжений реально начато, считает итог (`autoContinued`), а не эта строка.
 */
export function autoContinueNote({ kind, delayMs, attempt, budget }: {
  kind: TurnFailureKind | 'unknown';
  delayMs: number;
  attempt: number;
  budget: number;
}): string {
  return `Сбой хода: ${TURN_FAILURE_LABELS[kind]}. Через ${humanDelay(delayMs)} попрошу `
    + `агента продолжить с места остановки — попытка ${attempt} из ${budget} без продвижения. `
    + '«Стоп» или сообщение в очереди отменят.';
}

// Исходы, при которых ручная кнопка запрещена: человек уже решил сам. Остальные
// оставляют кнопку, если сессия пригодна: `not_resumable` говорит лишь о том, что
// АВТОМАТИКА не подтверждена, а не о потере сохранённого контекста.
const NO_BUTTON_OUTCOMES = new Set<AutoContinueOutcome>(['yielded']);
const NO_BUTTON_KINDS = new Set<TurnFailureKind | 'unknown'>([
  'auth',
  'usage_limit',
  'context_overflow',
  'policy',
  'bad_request',
]);

/**
 * Итог хода со сбоем доставки. `resumeAvailable` обязателен: функция не обещает
 * сохранённый контекст по одному тексту ошибки. Утверждение «ответа модели не было»
 * появляется только при явном `modelSpoke === false`.
 */
export function deliveryFailureView({ said, kind, outcome, attempts, resumeAvailable, modelSpoke }: {
  said: string;
  kind?: TurnFailureKind | 'unknown';
  outcome?: AutoContinueOutcome;
  attempts?: number;
  resumeAvailable: boolean;
  modelSpoke?: boolean;
}): { reply: string; resumable: boolean } {
  const silent = modelSpoke === false ? ', ответа модели не было' : '';
  let reply = `⚠ Ход оборвал сам CLI${silent}: «${said}».`;

  if (outcome === 'exhausted') {
    reply += ` Автопродолжение не помогло: начатых продолжений — ${attempts ?? 0}`
      + ` (${TURN_FAILURE_LABELS[kind || 'unknown']}).`;
  } else if (outcome === 'yielded') {
    reply += ' Автопродолжение отменено: поступило новое сообщение человека.';
  } else if (outcome === 'not_resumable') {
    reply += ' Автопродолжение недоступно: сохранность контекста не подтверждена.';
  } else if (outcome === 'disabled') {
    reply += ' Автопродолжение выключено в настройках.';
  } else if (outcome === 'not_continuable') {
    reply += noContinueReason(kind || 'unknown');
  }

  const suppressed = (outcome && NO_BUTTON_OUTCOMES.has(outcome))
    || (outcome === 'not_continuable' && NO_BUTTON_KINDS.has(kind || 'unknown'));
  const resumable = resumeAvailable && !suppressed;

  if (resumable) {
    reply += ' Контекст сохранён — нажми «Продолжить ход» или напиши «Продолжай»,'
      + ' и агент продолжит с этого места.';
  }

  return { reply, resumable };
}

/**
 * Отказ словами: у окончательных видов причина не пройдёт сама, и повтор не поможет.
 * Для остальных (в том числе unknown) середины нет — решает доступность сессии.
 */
function noContinueReason(kind: TurnFailureKind | 'unknown'): string {
  const label = TURN_FAILURE_LABELS[kind];

  if (kind === 'usage_limit') {
    return ` Сам не продолжаю: ${label} — до его сброса повтор не поможет.`;
  }

  if (kind === 'auth') {
    return ` Сам не продолжаю: ${label}. Проверь вход или ключ исполнителя в настройках.`;
  }

  if (kind === 'context_overflow') {
    return ` Сам не продолжаю: ${label}. Сожми контекст кнопкой на кольце и напиши,`
      + ' что делать дальше.';
  }

  if (kind === 'policy' || kind === 'bad_request') {
    return ` Сам не продолжаю: ${label}. Переформулируй запрос или начни новую сессию.`;
  }

  return '';
}

function stoppedError(fields: Record<string, unknown>): StoppedFailure {
  const error = new Error('Ход остановлен') as StoppedFailure;

  Object.assign(error, fields, { stopped: true });

  return error;
}

// Сигнал сбоя: адаптер называет его сам; иначе остаётся текст ответа, и решают общие слова.
function signalOf(out: ContinueRunResult): TurnFailureSignal {
  if (out.turnFailure) {
    return out.turnFailure;
  }

  return { message: String(out.reply ?? '') };
}

// Нормализация не-Error в Error с cause: ядро чата читает поля ошибки, а не её тип.
function asError(value: unknown): StoppedFailure {
  if (value instanceof Error) {
    return value as StoppedFailure;
  }

  return new Error(String(value ?? 'Неизвестная ошибка попытки'), { cause: value }) as StoppedFailure;
}

/**
 * Петля автопродолжения. Первый результат уже получен ядром; здесь решается, можно ли
 * продолжить тот же ход в той же сохранённой сессии после паузы. Успех новой попытки
 * возвращается сразу, поэтому метки сбоя предыдущей в итог не переносятся.
 */
export async function continueAfterFailures(
  first: ContinueRunResult,
  options: AutoContinueOptions,
): Promise<AutoContinueResult> {
  if (!first?.deliveryFailure) {
    return first;
  }

  const limit = options.maxContinuations ?? AUTO_CONTINUE_MAX_PER_TURN;
  const steps = [...stepsOf(first.steps)];
  let cost = costOf(first.cost);
  let continued = 0;
  let streak = 0;
  let out = first;
  let kind: TurnFailureKind | 'unknown' = 'unknown';
  let warned = false;

  // Снимок для ядра: копия массива, а не ссылка на изменяемый накопитель шагов.
  const snapshot = (): ContinueSummary => ({
    steps: [...steps],
    cost,
    continued,
  });

  options.onSummary(snapshot());

  for (;;) {
    if (options.signal?.aborted || out.stopped) {
      throw stoppedError({
        steps: [...steps],
        cost,
        autoContinued: continued,
        sessionId: out.sessionId ?? null,
      });
    }

    const verdict = classifyTurnFailure(signalOf(out), options.rules);

    kind = verdict.kind;

    if (kind === 'unknown' && !warned) {
      warned = true;
      options.log?.warn?.({
        failureKind: kind,
        code: signalOf(out).code || '',
        status: signalOf(out).status ?? null,
      }, `чат: сбой хода не распознан — ${cleanRunnerFailureMessage(signalOf(out).message)}`);
    }

    if (!options.isEnabled()) {
      return finish(out, 'disabled');
    }

    if (!verdict.continuable) {
      return finish(out, 'not_continuable');
    }

    const sessionId = typeof out.sessionId === 'string' ? out.sessionId : '';
    const recovery = out.turnRecovery;

    // Простое наличие id или сетевого текста разрешением продолжать не является:
    // адаптер обязан подтвердить принятую, окончательно завершённую попытку.
    if (out.sessionReset || out.sessionResetFailed || recovery?.canContinue !== true || !sessionId) {
      return finish(out, 'not_resumable');
    }

    if (recovery?.madeProgress === true) {
      streak = 0;
    }

    const delay = autoContinueDelay(kind as ContinuableKindKey, streak, options.delaysMs);

    if (delay === null || continued >= limit) {
      return finish(out, 'exhausted');
    }

    const scope = options.openWait();

    // Очередь человека, пришедшая РАНЬШЕ сбоя, отменяет автоматику сразу.
    if (options.hasQueued()) {
      scope.cancel('yielded');
    }

    if (scope.status() === 'aborted') {
      scope.dispose();

      throw stoppedError({
        steps: [...steps],
        cost,
        autoContinued: continued,
        sessionId,
      });
    }

    if (scope.status() === 'yielded') {
      scope.dispose();

      return finish(out, 'yielded');
    }

    // Подготовка: закрыть канал уточнений и недописанные блоки упавшей попытки.
    // Ошибка подготовки завершает ход штатным путём — продолжения после неё нет.
    try {
      await options.beforeWait();
    } catch (error) {
      scope.dispose();
      options.onSummary(snapshot());

      throw error;
    }

    if (scope.status() === 'aborted') {
      scope.dispose();

      throw stoppedError({
        steps: [...steps],
        cost,
        autoContinued: continued,
        sessionId,
      });
    }

    if (scope.status() === 'yielded' || options.hasQueued()) {
      scope.dispose();

      return finish(out, 'yielded');
    }

    if (!options.isEnabled()) {
      scope.dispose();

      return finish(out, 'disabled');
    }

    const attempt = streak + 1;
    const budget = autoContinueBudget(kind as ContinuableKindKey, options.delaysMs);
    const note: ChatStep = {
      k: 'note',
      level: 'warn',
      at: Date.now(),
      text: autoContinueNote({
        kind,
        delayMs: delay,
        attempt,
        budget,
      }),
    };

    try {
      options.publishNote(note);
    } catch (error) {
      scope.dispose();
      options.onSummary(snapshot());

      throw error;
    }

    steps.push(note);
    options.onSummary(snapshot());

    const waited = await scope.wait(delay);
    const cancelled = scope.status() || (waited === 'elapsed' ? null : waited);

    if (cancelled === 'aborted') {
      scope.dispose();

      throw stoppedError({
        steps: [...steps],
        cost,
        autoContinued: continued,
        sessionId,
      });
    }

    // Очередь отменяет даже после истёкшего ожидания: человек уже начал новый ход.
    if (cancelled === 'yielded' || options.hasQueued()) {
      scope.dispose();

      return finish(out, 'yielded');
    }

    if (!options.isEnabled()) {
      scope.dispose();

      return finish(out, 'disabled');
    }

    // Между последней проверкой отмены и вызовом попытки нет await: иначе новое
    // сообщение человека успело бы встать в очередь уже после решения продолжать.
    continued += 1;
    streak += 1;
    options.onSummary(snapshot());

    let pending: Promise<ContinueRunResult>;

    try {
      pending = options.run({ message: options.continueMessage, sessionId });
    } finally {
      scope.dispose();
    }

    try {
      out = await pending;
    } catch (error) {
      const failure = asError(error);

      if (!Array.isArray(failure.steps)) {
        failure.steps = [...stepsOf(options.attemptSteps())];
      }

      const tail = stepsOf(failure.steps);

      failure.steps = [...steps, ...tail];
      failure.cost = addCost(cost, failure.cost);
      failure.autoContinued = continued;
      options.onSummary(snapshot());

      throw failure;
    }

    steps.push(...stepsOf(out.steps));
    cost = addCost(cost, out.cost);
    options.onSummary(snapshot());

    if (!out.deliveryFailure) {
      return finish(out, 'recovered');
    }
  }

  /**
   * Итог цепочки: у успешной попытки берём ЕЁ поля (метки сбоя предыдущей не переносятся),
   * у сбойной — её же ответ, но с накопленной лентой, известной стоимостью и числом
   * действительно начатых продолжений.
   */
  function finish(current: ContinueRunResult, outcome: AutoContinueOutcome): AutoContinueResult {
    return {
      ...current,
      steps: [...steps],
      cost,
      failureKind: kind,
      autoContinued: continued,
      autoContinueOutcome: outcome,
    };
  }
}
