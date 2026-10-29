// Какие задачи арбитр разбирает ПРЯМО СЕЙЧАС.
//
// Арбитраж — это минуты живого агента, и всё это время задача снаружи выглядит ровно так
// же, как в момент остановки: та же плашка «конвейер встал», та же кнопка «разобрать и
// продолжить». Человек читает это как «стоит на мне» и идёт работать курьером — то есть
// делает руками ту самую работу, ради снятия которой арбитр и заведён.
//
// Прежний признак занятости жил ТОЛЬКО в нажавшем окне (локальный `arbiterBusy` в
// PipelineView): второе окно и автоматический вотчер не показывали ничего вовсе.
//
// Реестр намеренно в памяти процесса: живой ход принадлежит этому процессу и умирает
// вместе с ним. Переживи запись рестарт — она осталась бы фантомом, как умершие ходы
// чата в `activeRuns` (та же грабля, из-за которой их сверяют на каждом `hello`).
// Один идущий разбор: кто его начал, какой моделью и когда.
interface ArbiterRun {
  runId: string;
  task: string;
  actor: string;
  model: unknown;
  startedAt: number;
}

export class FactoryArbiterLive {
  private readonly runs = new Map<string, ArbiterRun>();

  private readonly onChange: (task: string) => void;

  constructor({ onChange = () => {} }: { onChange?: (task: string) => void } = {}) {
    this.onChange = onChange;
  }

  /**
   * Отметить начало разбора. Возвращает функцию завершения, которую обязан вызвать
   * `finally` вызывающего: потерянная отметка держала бы задачу «в разборе» навсегда.
   *
   * `actor` различает две одинаковых по цене дороги: нажатую человеком кнопку и обход
   * вотчера. Человеку важна вторая — она объясняет, почему разбор начался сам.
   */
  begin(task: unknown, { actor = 'human', model = null, runId = crypto.randomUUID() }: {
    actor?: string;
    model?: unknown;
    runId?: string;
  } = {}): () => void {
    const id = String(task || '');
    if (!id) return () => {};

    this.runs.set(id, {
      task: id,
      runId,
      actor,
      model,
      startedAt: Date.now(),
    });
    this.onChange(id);

    let done = false;

    return () => {
      if (done) return;

      done = true;

      if (this.runs.get(id)?.runId === runId) {
        this.runs.delete(id);
        this.onChange(id);
      }
    };
  }

  /** Публичная проекция для одной задачи: без внутренних ссылок и без модели-объекта. */
  read(task: unknown) {
    const run = this.runs.get(String(task || ''));
    if (!run) return null;
    return {
      actor: run.actor,
      model: run.model,
      startedAt: run.startedAt,
      elapsedSec: Math.max(0, Math.round((Date.now() - run.startedAt) / 1000)),
    };
  }

  /** Идёт ли хоть один разбор: дешёвая проверка для путей, где деталь не нужна. */
  get size() {
    return this.runs.size;
  }
}
