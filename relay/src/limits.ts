type Entry = {
  active: number;
  failures: number;
  window: number;
  bannedUntil: number;
};

/**
 * Ограничивает соединения до TLS и хранит не больше 4096 записей об адресах.
 * Освобождение слота идемпотентно; истёкшие окна удаляет явная периодическая очистка.
 */
export function createIpLimiter(options: {
  maxPerIp: number;
  banThreshold: number;
  banWindowMs: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  /**
   * Удаляет истёкшие окна, сохраняя учёт ещё открытых соединений.
   * Ограничение таблицы не зависит от возвращения прежнего адреса.
   */
  function sweep() {
    const time = now();

    for (const [ip, entry] of entries) {
      if (time - entry.window >= options.banWindowMs && time >= entry.bannedUntil) {
        entry.failures = 0;
        entry.bannedUntil = 0;
        entry.window = time;
      }

      if (entry.active === 0 && entry.failures === 0 && entry.bannedUntil === 0) {
        entries.delete(ip);
      }
    }
  }

  /**
   * Находит или создаёт запись только в пределах фиксированного бюджета.
   * Заполненная таблица отказывает новому адресу без вытеснения действующего бана.
   */
  function entryFor(ip: string): Entry | null {
    const known = entries.get(ip);

    if (known) {
      return known;
    }

    if (entries.size >= 4096) {
      sweep();
    }

    if (entries.size >= 4096) {
      return null;
    }

    const entry = {
      active: 0,
      failures: 0,
      window: now(),
      bannedUntil: 0,
    };

    entries.set(ip, entry);

    return entry;
  }

  return {
    sweep,
    get size() {
      return entries.size;
    },
    banned(ip: string) {
      return (entries.get(ip)?.bannedUntil ?? 0) > now();
    },
    /**
     * Каждое соединение резервирует место до создания пары и учитывается по IP.
     * Однократный release снимает счётчик и позволяет удалить пустую запись.
     */
    acquire(ip: string) {
      const entry = entryFor(ip);

      if (!entry || entry.active >= options.maxPerIp) {
        return null;
      }

      entry.active += 1;

      let released = false;

      return {
        release() {
          if (!released) {
            released = true;
            entry.active -= 1;
            sweep();
          }
        },
      };
    },
    /**
     * Ошибки аутентификации считаются внутри ограниченного временного окна.
     * Превышение порога временно закрывает новые подключения этого адреса.
     */
    failure(ip: string) {
      const entry = entryFor(ip);

      if (!entry) {
        return;
      }

      const time = now();

      if (time - entry.window >= options.banWindowMs) {
        entry.window = time;
        entry.failures = 0;
      }

      entry.failures += 1;

      if (entry.failures >= options.banThreshold) {
        entry.bannedUntil = time + options.banWindowMs;
      }
    },
  };
}
