type TimerHandle = number | { unref?: () => void };

interface TimerPort {
  setInterval(callback: () => unknown, interval: number): TimerHandle;
  clearInterval(timer: TimerHandle): void;
}

/**
 * Свежесть лимитов, пока всплывашка исполнителя открыта.
 *
 * Цифры брались один раз — на наведение, — и дальше стояли: открытая всплывашка могла
 * час показывать проценты часовой давности, хотя окно сессии за это время успевало
 * смениться. Пока всплывашка открыта, лимиты перечитываются тиком; закрылась — опрос
 * прекращается, потому что показывать его результат уже некому.
 *
 * Всплывашка раскрывается наведением, и при переходе от одного исполнителя к соседнему
 * события идут внахлёст: `close` прежней приходит уже ПОСЛЕ `open` следующей. Поэтому
 * сторож помнит, чья всплывашка держит опрос, и чужое закрытие его не гасит — иначе
 * проведённая по ряду иконок мышь оставляла бы открытую всплывашку без обновлений.
 */
export function createUsageWatch(
  load: () => unknown,
  {
    intervalMs = 30_000,
    // Порт возвращает и принимает handle одного владельца: число в браузере, объект в Node.
    timers = globalThis as TimerPort,
  }: { intervalMs?: number; timers?: TimerPort } = {},
) {
  let owner = '';
  let timer: TimerHandle | null = null;

  /**
   * Снимает таймер текущего владельца и очищает имя открытой всплывашки.
   * Один и тот же путь используется закрытием и полным освобождением наблюдателя.
   */
  function stop(): void {
    if (timer !== null) {
      timers.clearInterval(timer);
    }

    timer = null;
    owner = '';
  }

  return {
    /**
     * Раскрытие всплывашки — само по себе повод перечитать: между прошлым чтением и
     * этим наведением могла пройти минута троттла. Серверный кэш при этом НЕ обходим:
     * всплывашка раскрывается наведением, и обход означал бы поход в API вендора на
     * каждое движение мыши по ряду иконок.
     */
    open(id: string): void {
      if (timer !== null) {
        timers.clearInterval(timer);
      }

      owner = id;
      timer = timers.setInterval(() => load(), intervalMs);
      (timer as { unref?: () => void } | null)?.unref?.();
      load();
    },

    close(id: string): void {
      if (owner !== id) {
        return;
      }

      stop();
    },

    stop,

    get openFor() {
      return owner;
    },
  };
}
