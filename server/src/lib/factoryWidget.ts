// Счётчики конвейера для виджета главного экрана телефона.
// Виджет получает только агрегаты: текст задач и причины остановок не покидают сервер.
// Правила близки к мобильному фасаду attention, но осознанно отличаются: ожидание
// человека важнее краха, read-only проекции пропускаются, ворота читаются из stageMap
// (карты статусов реестра, заглавные ключи route-v2), а не из массива ключей stages.

export interface FactoryWidgetTask {
  result: string | null;
  readOnly: boolean;
  stalledHuman: boolean;
  bootstrapStop: { state?: unknown } | null;
  stall: { kind?: unknown } | null;
  daemonAlive: boolean;
  stageMap: Record<string, { status?: unknown } | undefined>;
}

export interface FactoryWidgetCounters {
  running: number;
  waiting: number;
  stalled: number;
}

const GATE_WAIT_STATUSES = new Set(['wait', 'waiting', 'premature']);
const BOOTSTRAP_WAIT_STATES = new Set(['waiting', 'answered']);
const TERMINAL_RESULTS = new Set(['completed', 'abandoned']);

/**
 * Одна задача попадает ровно в один счётчик: сначала «ждёт человека», затем
 * «остановлена», затем «в работе». Завершённые и архивные read-only проекции
 * не считаются: виджет показывает только живой конвейер.
 */
export function factoryWidgetCounters(tasks: readonly FactoryWidgetTask[]): FactoryWidgetCounters {
  const counters: FactoryWidgetCounters = {
    running: 0,
    waiting: 0,
    stalled: 0,
  };

  for (const task of tasks) {
    if (task.readOnly || TERMINAL_RESULTS.has(String(task.result))) {
      continue;
    }

    if (task.stalledHuman || bootstrapWaiting(task.bootstrapStop)
      || task.stall?.kind === 'human' || gateWaiting(task.stageMap)) {
      counters.waiting += 1;
    } else if (task.stall != null) {
      counters.stalled += 1;
    } else if (task.daemonAlive) {
      counters.running += 1;
    }
  }

  return counters;
}

/**
 * Разведка ждёт человека только в состояниях waiting и answered.
 * Состояние running — повторный SCOUT после ответа: задача работает, не ждёт.
 */
function bootstrapWaiting(stop: FactoryWidgetTask['bootstrapStop']): boolean {
  return stop != null && BOOTSTRAP_WAIT_STATES.has(String(stop.state));
}

/**
 * Ворота маршрута ждут человека: ключи реестра заглавные в обеих проекциях
 * (route-v2 и legacy), сравнение без регистра — защита; wait/premature —
 * статусы графа, в реестре встречается waiting.
 */
function gateWaiting(stageMap: FactoryWidgetTask['stageMap']): boolean {
  return Object.entries(stageMap || {}).some(([key, node]) => key.toUpperCase().startsWith('GATE_')
    && GATE_WAIT_STATUSES.has(String(node?.status)));
}
