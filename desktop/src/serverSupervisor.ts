import type { GrigDeskProbe } from '../../shared/runtime/grigDeskReadiness.ts';
import { DESKTOP_RESTART_EXIT_CODE } from '../../server/src/lib/desktopParent.ts';
import type { ServerRuntime } from './runtimeConfig.ts';

export type StartDecision = 'connect' | 'wait' | 'spawn' | 'conflict';
export type Ownership = 'none' | 'external' | 'owned';

export interface ChildHandle {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export interface SupervisorAdapters {
  loadRuntime(): Promise<{ runtime: ServerRuntime } | { problem: string; message: string }>;
  probe(signal: AbortSignal): Promise<GrigDeskProbe>;
  unitState(signal: AbortSignal): Promise<string>;
  runGate(runtime: ServerRuntime, signal: AbortSignal): Promise<{ code: number; lastLine: string }>;
  spawnServer(runtime: ServerRuntime): ChildHandle;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  log(message: string): void;
}

export interface ServerSupervisor {
  readonly ownership: Ownership;
  readonly generation: number;
  readonly waitReason: string | null;
  ensure(input: {
    origin: string;
    signal: AbortSignal;
    deadline: number;
  }): Promise<void>;
  stop(): Promise<void>;
}

type EnsureInput = Parameters<ServerSupervisor['ensure']>[0];

interface OwnedChild {
  handle: ChildHandle;
  runtime: ServerRuntime;
  ended: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  exited: Promise<void>;
  termination: Promise<void> | null;
}

/**
 * Выбирает действие по ответу HTTP и снимку службы без побочных эффектов.
 * Решение о запуске принимается только при явно закрытом порте и свободной службе.
 */
export function decideStart(probe: GrigDeskProbe, unitState: string): StartDecision {
  if (probe === 'grigdesk') {
    return 'connect';
  }

  if (probe === 'other') {
    return 'conflict';
  }

  if (probe === 'no_answer' || ['active', 'activating', 'reloading', 'deactivating'].includes(unitState)) {
    return 'wait';
  }

  return 'spawn';
}

/**
 * Управляет только процессом, который создал этот экземпляр приложения.
 * Проверки, время и эффекты передаются портами, внешнему серверу сигналы не посылаются.
 */
export function createServerSupervisor(adapters: SupervisorAdapters): ServerSupervisor {
  let ownership: Ownership = 'none';
  let generation = 0;
  let waitReason: string | null = null;
  let current: OwnedChild | null = null;
  let pending: Promise<void> | null = null;
  let workController: AbortController | null = null;
  let lastOrigin: string | null = null;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  /**
   * Отличает истёкший бюджет от выхода приложения и внешней отмены.
   * Причина последнего ожидания дополняет сообщение о сроке, включая VPN-ворота.
   */
  function interruption(input: EnsureInput): Error {
    if (!stopping && adapters.now() >= input.deadline) {
      const detail = waitReason ? ` ${waitReason}.` : '';

      return new Error(`Истёк срок запуска сервера GrigDesk.${detail}`);
    }

    return new Error('Старт сервера GrigDesk отменён.');
  }

  /**
   * Отсекает поздний ответ асинхронного порта после отмены или срока.
   * Эта проверка запрещает побочные эффекты, даже если порт не умеет прерывать своё ожидание.
   */
  function check(input: EnsureInput): void {
    if (stopping || input.signal.aborted || adapters.now() >= input.deadline) {
      throw interruption(input);
    }
  }

  /**
   * Снимок службы нужен только при закрытом порте, остальные ответы уже задают решение.
   * Отмена и срок не дают позднему ответу начать запуск.
   */
  async function decision(input: EnsureInput): Promise<StartDecision> {
    check(input);

    const probe = await adapters.probe(input.signal);

    check(input);

    if (probe !== 'refused') {
      if (probe === 'no_answer') {
        waitReason = 'сервер не отвечает';
      }

      return decideStart(probe, 'unavailable');
    }

    const state = await adapters.unitState(input.signal);

    check(input);

    const result = decideStart(probe, state);

    if (result === 'wait') {
      waitReason = 'служба запускается';
    }

    return result;
  }

  /**
   * Подключение сохраняет владение только живым собственным процессом.
   * Конфликт на порту завершается понятной причиной до ворот и spawn.
   */
  function connectedOrConflict(result: StartDecision, input: EnsureInput): boolean {
    if (result === 'connect') {
      ownership = current && !current.ended ? 'owned' : 'external';
      waitReason = null;

      return true;
    }

    if (result === 'conflict') {
      const port = new URL(input.origin).port || '80';

      throw new Error(`Порт ${port} занят другой программой, это не GrigDesk.`);
    }

    return false;
  }

  /**
   * Перезапуск проходит тот же конвейер с новым сроком и снимком runtime.
   * Его отказ остаётся рабочим offline-сценарием и сообщает причину только через журнал main.
   */
  async function restart(origin: string): Promise<void> {
    await pending?.catch(() => {});

    if (stopping) {
      return;
    }

    try {
      await ensure({
        origin,
        signal: new AbortController().signal,
        deadline: adapters.now() + 90_000,
      });
    } catch (error) {
      if (!stopping) {
        const message = error instanceof Error ? error.message : String(error);

        adapters.log(`Сервер GrigDesk: ${message}`);
      }
    }
  }

  /**
   * Наблюдает exit и ошибку без pid сразу после синхронного spawn.
   * Закрытие stdio не снимает владение, поскольку дескрипторы могут держать потомки.
   */
  function observe(handle: ChildHandle, runtime: ServerRuntime): OwnedChild {
    let completeExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      completeExit = resolve;
    });
    const child: OwnedChild = {
      handle,
      runtime,
      ended: false,
      code: null,
      signal: null,
      exited,
      termination: null,
    };

    current = child;
    ownership = 'owned';
    generation += 1;

    /**
     * Снимает владение только с того поколения, которое действительно завершилось.
     * Ожидание выхода разрешается независимо от текущего поколения и слушателей stdio.
     */
    function finished(code: number | null, signal: NodeJS.Signals | null): void {
      if (child.ended) {
        return;
      }

      child.ended = true;
      child.code = code;
      child.signal = signal;
      completeExit();

      if (current === child) {
        current = null;
        ownership = 'none';

        if (!stopping && code === DESKTOP_RESTART_EXIT_CODE && lastOrigin) {
          void restart(lastOrigin);
        }
      }
    }

    handle.once('exit', finished);
    handle.once('error', () => {
      if (!handle.pid) {
        finished(1, null);
      }
    });

    return child;
  }

  /**
   * Каждая пауза сохраняет общий бюджет и принимает сигнал внешней отмены.
   * Часы и ожидание подменяются вместе, поэтому тесты проверяют последовательность без реального сна.
   */
  async function sleep(ms: number, input: EnsureInput): Promise<void> {
    check(input);
    await adapters.sleep(Math.min(ms, input.deadline - adapters.now()), input.signal);
    check(input);
  }

  /**
   * Готовность своего сервера требует живого процесса на момент результата probe.
   * После его раннего выхода один новый probe отличает внешнего владельца от отказа запуска.
   */
  async function waitOwn(child: OwnedChild, input: EnsureInput): Promise<void> {
    waitReason = 'свой сервер запускается';

    while (!child.ended) {
      check(input);

      const probe = await adapters.probe(input.signal);

      check(input);

      if (child.ended) {
        break;
      }

      if (probe === 'grigdesk') {
        ownership = 'owned';
        waitReason = null;

        return;
      }

      await sleep(500, input);
    }

    const probe = await adapters.probe(input.signal);

    check(input);

    if (probe === 'grigdesk') {
      ownership = 'external';
      waitReason = null;

      return;
    }

    const code = child.code ?? child.signal ?? 'неизвестен';

    throw new Error(
      `Сервер GrigDesk завершился при запуске (код ${code}). Журнал: ${child.runtime.logPath}.`,
    );
  }

  /**
   * Проходит проверки заново после ожидания службы или VPN и непосредственно перед spawn.
   * Runtime читается только при необходимости своего запуска, внешнему серверу установка не нужна.
   */
  async function start(input: EnsureInput): Promise<void> {
    while (true) {
      const first = await decision(input);

      if (connectedOrConflict(first, input)) {
        return;
      }

      if (first === 'wait') {
        await sleep(500, input);
        continue;
      }

      const loaded = await adapters.loadRuntime();

      check(input);

      if ('problem' in loaded) {
        throw new Error(loaded.message);
      }

      const runtime = loaded.runtime;

      if (input.origin !== runtime.origin) {
        throw new Error(`Окно открыто для ${input.origin}, а установка слушает порт ${runtime.port}:`
          + ' автозапуск невозможен.');
      }

      const gate = await adapters.runGate(runtime, input.signal);

      if (gate.code !== 0) {
        // Строки скрипта ворот уже начинаются с «VPN-ворота:», префикс не дублируется.
        waitReason = gate.lastLine.startsWith('VPN-ворота') ? gate.lastLine : `VPN-ворота: ${gate.lastLine}`;
        await sleep(5000, input);
        continue;
      }

      check(input);

      const repeated = await decision(input);

      if (connectedOrConflict(repeated, input)) {
        return;
      }

      if (repeated !== 'spawn') {
        await sleep(500, input);
        continue;
      }

      const child = observe(adapters.spawnServer(runtime), runtime);

      await waitOwn(child, input);

      return;
    }
  }

  /**
   * Параллельные запросы готовности ждут один конвейер, чтобы не породить два процесса.
   * После завершения конвейера новый запрос может заново проверить доступность сервера.
   */
  function ensure(input: EnsureInput): Promise<void> {
    if (stopping) {
      return Promise.reject(new Error('Старт сервера GrigDesk отменён.'));
    }

    if (pending) {
      return pending;
    }

    lastOrigin = input.origin;

    const controller = new AbortController();

    workController = controller;

    const activeInput = {
      ...input,
      signal: AbortSignal.any([input.signal, controller.signal]),
    };
    let onAbort: () => void = () => {};
    const interrupted = new Promise<void>((_resolve, reject) => {
      onAbort = () => reject(interruption(activeInput));
      activeInput.signal.addEventListener('abort', onAbort, { once: true });

      if (activeInput.signal.aborted) {
        onAbort();
      }
    });
    const deadlineTimer = setTimeout(() => controller.abort(),
      Math.max(0, input.deadline - adapters.now()));

    deadlineTimer.unref?.();

    pending = Promise.race([start(activeInput), interrupted]).finally(() => {
      clearTimeout(deadlineTimer);
      activeInput.signal.removeEventListener('abort', onAbort);
      pending = null;
      workController = null;
    });

    return pending;
  }

  /**
   * Сигналы разрешены только живому сохранённому ChildProcess этого supervisor.
   * Полученный exit и уже заполненные поля процесса исключают повторное убийство.
   */
  function alive(child: OwnedChild): boolean {
    return !child.ended && child.handle.exitCode === null && child.handle.signalCode === null;
  }

  /**
   * Соревнуется только событие exit с ограниченным ожиданием времени.
   * Завершение соревнования снимает таймер через сигнал, чтобы stop не оставлял живые ожидания.
   */
  async function exitedWithin(child: OwnedChild, ms: number): Promise<boolean> {
    if (!alive(child)) {
      return true;
    }

    const timer = new AbortController();

    try {
      return await Promise.race([
        child.exited.then(() => true),
        adapters.sleep(ms, timer.signal).then(() => false),
      ]);
    } finally {
      timer.abort();
    }
  }

  /**
   * Даёт своему серверу весь бюджет штатного слива, затем только живому шлёт SIGKILL.
   * После принудительного сигнала ожидание exit ограничено ещё пятью секундами.
   */
  async function drain(child: OwnedChild): Promise<void> {
    if (!alive(child)) {
      return;
    }

    child.handle.kill('SIGTERM');

    if (await exitedWithin(child, child.runtime.graceMs)) {
      return;
    }

    if (alive(child)) {
      child.handle.kill('SIGKILL');
    }

    await exitedWithin(child, 5000);
  }

  /**
   * Отмена синхронно закрывает возможность позднего spawn и нового поколения.
   * Уборка берёт процесс после текущего синхронного участка; повторные stop ждут одно обещание.
   */
  function stop(): Promise<void> {
    if (stopPromise) {
      return stopPromise;
    }

    stopping = true;
    workController?.abort();
    void pending?.catch(() => {});

    stopPromise = Promise.resolve().then(async () => {
      const child = current;

      if (child) {
        child.termination ??= drain(child);
        await child.termination;
      }
    });

    return stopPromise;
  }

  return {
    get ownership() {
      return ownership;
    },
    get generation() {
      return generation;
    },
    get waitReason() {
      return waitReason;
    },
    ensure,
    stop,
  };
}
