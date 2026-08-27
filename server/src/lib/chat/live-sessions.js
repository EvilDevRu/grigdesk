// Пул живых сессий исполнителей: процесс агента переживает свой ход.
//
// Раньше кокпит поднимал CLI на КАЖДОЕ сообщение и убивал вместе с ответом. Поэтому
// всё, что агент оставлял после себя, умирало тоже: фоновые команды, субагенты и любое
// ожидание. Здесь процесс живёт до простоя, смены модели или остановки сервера, а ход
// становится отрезком его потока.
//
// Модуль provider-neutral: он не знает ни claude, ни codex. Умеет ли исполнитель жить
// между ходами, объявляет он сам полем `session` своего контракта; пул только владеет
// временем жизни, потолком и доставкой непрошеных ходов.

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 4;
// Что нельзя поменять на лету: это флаги командной строки, зафиксированные при запуске
// процесса. Исполнитель вправе назвать свой набор — тогда сессия переоткроется только
// на его полях.
const DEFAULT_RESTART_ON = [
  'model', 'effort', 'permissionMode', 'cwd', 'extraDirs', 'workToolScopeKey',
];

function fingerprintOf(spec, fields) {
  const parts = {};
  for (const field of fields) {
    const value = spec[field];
    parts[field] = Array.isArray(value) ? [...value].sort() : (value ?? null);
  }
  return JSON.stringify(parts);
}

export class ChatLiveSessions {
  constructor({
    maxSessions = DEFAULT_MAX_SESSIONS,
    idleMs = DEFAULT_IDLE_MS,
    log = null,
    onBackgroundTurn = null,
    onBackgroundStep = null,
    onBackgroundProgress = null,
    onSessionClosed = null,
    onChange = null,
  } = {}) {
    this.maxSessions = Math.max(1, Number(maxSessions) || DEFAULT_MAX_SESSIONS);
    this.idleMs = Math.max(60_000, Number(idleMs) || DEFAULT_IDLE_MS);
    this.log = log;
    this.onBackgroundTurn = onBackgroundTurn;
    this.onBackgroundStep = onBackgroundStep;
    this.onBackgroundProgress = onBackgroundProgress;
    this.onSessionClosed = onSessionClosed;
    // Состав пула меняется редко (открытие, простой, вытеснение, смерть процесса),
    // поэтому о нём можно честно оповещать окна, а не заставлять их опрашивать список.
    this.onChange = onChange;
    this.entries = new Map();
    this.closed = false;
  }

  /**
   * Ход через живую сессию: берём подходящую, иначе открываем. Возвращает то же, что
   * разовый `executor.run`, поэтому вызывающий код о смене модели работы не знает.
   */
  async run(spec, turn) {
    const entry = await this._acquire(spec);
    entry.busy = true;
    this._clearIdle(entry);
    try {
      const result = await entry.handle.send(turn);
      // sessionId нужен и живой сессии: по нему она переоткроется после простоя,
      // рестарта сервера или смены модели.
      if (result?.sessionId) entry.sessionId = result.sessionId;
      return result;
    } finally {
      entry.busy = false;
      entry.lastUsed = Date.now();
      if (this.entries.get(entry.chatKey) === entry) this._armIdle(entry);
    }
  }

  /** «Стоп» человека: прерываем ход, сессию и её память сохраняем. */
  async interrupt(chatKey) {
    const entry = this.entries.get(String(chatKey || ''));
    if (!entry?.handle?.alive) return false;
    await entry.handle.interrupt();
    return true;
  }

  has(chatKey) {
    const entry = this.entries.get(String(chatKey || ''));
    return !!entry?.handle?.alive;
  }

  async close(chatKey, reason = 'закрыта') {
    const entry = this.entries.get(String(chatKey || ''));
    if (!entry) return false;
    this._forget(entry, reason);
    await entry.handle.close().catch(() => {});
    return true;
  }

  async closeAll(reason = 'остановка сервера') {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this._clearIdle(entry);
    await Promise.all(entries.map((entry) => entry.handle.close().catch(() => {})));
    if (entries.length) {
      this.log?.info({ count: entries.length, reason }, 'чат: живые сессии закрыты');
      this.onChange?.({ chatKey: '', event: 'closed', reason });
    }
  }

  /**
   * Что за процессы сейчас живут. Отдаём то, чем человек отличает одну сессию от
   * другой и по чему сверяет её с `ps`: pid, исполнителя, параметры запуска и время
   * до автоматического гашения. Секретов здесь нет — env и аргументы наружу не идут.
   */
  stats() {
    const now = Date.now();
    return [...this.entries.values()].map((entry) => ({
      chatKey: entry.chatKey,
      executor: entry.executorId,
      pid: entry.handle?.pid ?? null,
      alive: !!entry.handle?.alive,
      busy: !!entry.busy,
      unsolicited: !!entry.unsolicited,
      sessionId: entry.sessionId || null,
      model: entry.model || '',
      effort: entry.effort || '',
      permissionMode: entry.permissionMode || '',
      cwd: entry.cwd || '',
      extraDirs: entry.extraDirs || [],
      openedAt: entry.openedAt,
      lastUsed: entry.lastUsed,
      // Занятая сессия по простою не гаснет: таймер перевзводится, пока идёт ход.
      idleAtMs: entry.busy ? null : Math.max(now, entry.lastUsed + this.idleMs),
    }));
  }

  /** Границы пула — чтобы окно объясняло их словами, а не повторяло числа у себя. */
  limits() {
    return { maxSessions: this.maxSessions, idleMs: this.idleMs, live: this.entries.size };
  }

  async _acquire(spec) {
    const chatKey = String(spec.chatKey || '');
    if (!chatKey) throw new Error('Живая сессия требует ключ чата.');
    if (this.closed) throw new Error('Сервер останавливается — новая сессия не открывается.');

    const executor = spec.executor;
    const session = executor?.session;
    if (!session?.open) throw new Error(`Исполнитель ${executor?.id || '?'} не умеет жить между ходами.`);

    const fields = Array.isArray(session.restartOn) && session.restartOn.length
      ? session.restartOn
      : DEFAULT_RESTART_ON;
    const fingerprint = fingerprintOf(spec, fields);

    const existing = this.entries.get(chatKey);
    if (existing) {
      // Присланный клиентом id сессии сравниваем, только когда он НЕПУСТ: пустой значит
      // «окно ещё не знает id», а не «начни заново». Осознанный сброс памяти закрывает
      // сессию отдельным вызовом close() — иначе отставшее окно рвало бы живой разговор.
      const foreignSession = !!spec.sessionId
        && !!existing.sessionId
        && spec.sessionId !== existing.sessionId;
      const reusable = existing.handle.alive
        && existing.fingerprint === fingerprint
        && existing.executorId === executor.id
        && !foreignSession;
      if (reusable) return existing;

      // Сессия умерла сама либо изменилось то, что задаётся при запуске процесса.
      // Разговор при этом не теряется: новый процесс поднимается с прежним sessionId.
      const reason = !existing.handle.alive
        ? 'процесс завершился'
        : (foreignSession ? 'сменился id сессии' : 'изменились параметры запуска');
      this._forget(existing, reason);
      spec = { ...spec, sessionId: spec.sessionId || existing.sessionId };
      await existing.handle.close().catch(() => {});
    }

    await this._enforceLimit();

    const entry = {
      chatKey,
      executorId: executor.id,
      unsolicited: !!session.unsolicited,
      fingerprint,
      sessionId: spec.sessionId || null,
      // Копия параметров запуска: они зафиксированы на жизнь процесса, и человек по
      // ним понимает, почему сессия переоткрылась и чем этот процесс отличается от
      // выбранного сейчас в чате.
      model: spec.model || '',
      effort: spec.effort || '',
      permissionMode: spec.permissionMode || '',
      cwd: spec.cwd || '',
      extraDirs: Array.isArray(spec.extraDirs) ? [...spec.extraDirs] : [],
      busy: false,
      openedAt: Date.now(),
      lastUsed: Date.now(),
      idleTimer: null,
      handle: null,
    };

    entry.handle = await session.open({
      ...spec,
      log: this.log,
      hooks: {
        onBackgroundStart: () => {
          this.log?.info({ chatKey }, 'чат: агент проснулся сам');
        },
        onBackgroundStep: (step) => this.onBackgroundStep?.({ chatKey, step }),
        onBackgroundProgress: (tokens, extra) => this.onBackgroundProgress?.({ chatKey, tokens, extra }),
        onBackground: (result) => {
          if (result?.sessionId) entry.sessionId = result.sessionId;
          entry.lastUsed = Date.now();
          this.onBackgroundTurn?.({ chatKey, executorId: entry.executorId, result });
        },
        onExit: ({ reason }) => {
          if (this.entries.get(chatKey) === entry) this._forget(entry, reason || 'процесс завершился');
          this.onSessionClosed?.({ chatKey, reason: reason || '' });
        },
      },
    });

    this.entries.set(chatKey, entry);
    this._armIdle(entry);
    this.log?.info(
      { chatKey, executor: entry.executorId, pid: entry.handle.pid },
      'чат: открыта живая сессия',
    );
    this.onChange?.({ chatKey, event: 'opened' });
    return entry;
  }

  /**
   * Потолок живых процессов — обязательная часть, а не отделка: каждый держит память
   * и свои MCP-серверы. Гасим самую давнюю СВОБОДНУЮ сессию; если свободных нет,
   * ход человека важнее потолка, но это остаётся в журнале.
   */
  async _enforceLimit() {
    while (this.entries.size >= this.maxSessions) {
      const idle = [...this.entries.values()]
        .filter((entry) => !entry.busy)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) {
        this.log?.warn(
          { live: this.entries.size, limit: this.maxSessions },
          'чат: все живые сессии заняты, потолок превышен',
        );
        return;
      }
      this._forget(idle, 'вытеснена по потолку живых сессий');
      await idle.handle.close().catch(() => {});
    }
  }

  _armIdle(entry) {
    this._clearIdle(entry);
    entry.idleTimer = setTimeout(() => {
      if (entry.busy) {
        this._armIdle(entry);
        return;
      }
      this._forget(entry, 'простой');
      entry.handle.close().catch(() => {});
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  _clearIdle(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  _forget(entry, reason) {
    this._clearIdle(entry);
    const owned = this.entries.get(entry.chatKey) === entry;
    if (owned) this.entries.delete(entry.chatKey);
    this.log?.info({ chatKey: entry.chatKey, reason }, 'чат: живая сессия закрыта');
    // Оповещаем только владельца записи: вытесненная запись уже сообщила о себе,
    // и второй раз перечитывать список окнам незачем.
    if (owned) this.onChange?.({ chatKey: entry.chatKey, event: 'closed', reason });
  }
}
