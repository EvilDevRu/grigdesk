import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';

import { delayWithAbort } from '../../shared/lib/delay.ts';
import { isRecord } from '../../shared/lib/objects.ts';
import {
  decodeDesktopExitDecision, decodeDesktopExitSnapshot, decodeStrictDesktopExitInspection,
} from '../../shared/desktop/desktopExitContract.ts';
import type {
  DesktopExitCommandType, DesktopExitSnapshot,
} from '../../shared/desktop/desktopExitContract.ts';
import type { DesktopExitPreference } from './desktopExitPreference.ts';
import { createDesktopExitBridge } from './desktopExitBridge.ts';
import { desktopText } from './locale.ts';

interface ExitSupervisor {
  readonly ownership: string;
  readonly generation: number;
  stop(): Promise<void>;
}

export interface DesktopExitContext {
  window: BrowserWindow;
  origin: string;
  profileId: string;
  address: string;
  selectedOrigin: string | null;
  local: boolean;
  strict?: boolean;
  supervisor: ExitSupervisor;
}

interface StrictAdmission {
  confirm(signal: AbortSignal): Promise<void>;
  proveOwnedServerStopped(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
}

interface ExitOperation {
  id: string;
  context: DesktopExitContext;
  generation: number;
  ownership: string;
  bridge: ReturnType<typeof createDesktopExitBridge>;
  controller: AbortController;
  phase: 'inspecting' | 'prompt' | 'stopping' | 'finishing';
  remember?: boolean;
  deadline?: ReturnType<typeof setTimeout>;
}

interface ExitOptions {
  context(): DesktopExitContext | null;
  revealed(): boolean;
  quitting(): boolean;
  preference(): DesktopExitPreference;
  applyUpdate?(signal?: AbortSignal): Promise<boolean | 'applied' | 'idle' | 'blocked'> | null;
  acquireStrictAdmission?(signal: AbortSignal, expectsOwnedServer: boolean): Promise<StrictAdmission>;
  warnStrict?(): void;
  log(message: string): void;
  exit(): void;
}

/**
 * Только пользовательский close проходит предварительный слив с живым окном и трубой.
 * Системный выход остаётся во владении прежнего quitController и отменяет эту фазу.
 */
export function createDesktopExitController(options: ExitOptions) {
  let active: ExitOperation | null = null;
  let nativeClose = false;
  let strictCommitted = false;

  /**
   * Вопрос касается выбранного местного происхождения независимо от владения сервером:
   * отдельно запущенный сервер получает вопрос и остановку конвейеров, хотя слив остаётся
   * уделом собственного сервера. Скрытое окно не удерживает запуск и сохраняет прежний
   * путь отказа старта, а удалённая машина идёт мимо предварительной фазы.
   */
  function eligible(context: DesktopExitContext): boolean {
    return (context.strict || options.revealed() && context.window.isVisible())
      && !context.window.isDestroyed()
      && context.local && context.address === context.selectedOrigin;
  }

  /**
   * Все эффекты привязаны к захваченным машине, документу и поколению supervisor.
   * Смена владения посреди операции отменяет её: слив начатого чужого сервера недопустим.
   * После начала stop переход owned в none ожидаем и не снимает общий срок.
   */
  function current(operation: ExitOperation, requireOwned = true): boolean {
    const context = options.context();
    const captured = operation.context;

    return active === operation && !operation.controller.signal.aborted && !options.quitting()
      && !!context && context.window === captured.window && context.origin === captured.origin
      && context.profileId === captured.profileId && context.address === captured.address
      && context.selectedOrigin === captured.selectedOrigin && context.local
      && context.strict === captured.strict
      && context.supervisor === captured.supervisor && context.supervisor.generation === operation.generation
      && (!requireOwned || context.supervisor.ownership === operation.ownership) && operation.bridge.valid();
  }

  /**
   * Очистка освобождает подписки и ожидания только своей операции.
   * В finishing таймер сохраняется до фактического app.exit, включая cookies и writer.
   */
  function clear(preserveDeadline = false): void {
    const operation = active;

    if (!operation) {
      return;
    }

    operation.controller.abort();
    operation.bridge.dispose();

    if (!preserveDeadline) {
      clearTimeout(operation.deadline);
      active = null;
    }
  }

  /**
   * Обычный close сначала освобождает запрос renderer: beforeunload может оставить документ живым.
   * Отмена ограничена сроком; только finishing позволяет main снять защиту несохранённых правок.
   */
  async function closeNative(operation: ExitOperation, finishing: boolean): Promise<void> {
    if (active !== operation) {
      return;
    }

    if (finishing) {
      operation.phase = 'finishing';
      strictCommitted = operation.context.strict === true;
    } else {
      await send(operation, 'cancel', 2000);

      if (active !== operation) {
        return;
      }

      clear();
    }

    nativeClose = true;

    try {
      if (!operation.context.window.isDestroyed()) {
        operation.context.window.close();
      }
    } finally {
      nativeClose = false;
    }
  }

  /**
   * Отменяет только текущий строгий выход. Renderer получает отмену, а предупреждение
   * остаётся привязанным к тому же окну для повторного решения.
   */
  async function cancelStrict(operation: ExitOperation): Promise<void> {
    if (active !== operation) {
      return;
    }

    clearTimeout(operation.deadline);
    operation.controller.abort();
    await operation.bridge.request({
      type: 'cancel',
      requestId: operation.id,
      expiresAt: Date.now() + 1200,
      strict: true,
    }, AbortSignal.timeout(1200)).catch(() => {});

    if (active === operation) {
      clear();
      options.warnStrict?.();
    }
  }

  /**
   * Срок команды фиксируется при отправке, а не при её позднем исполнении в renderer.
   * Каждая доставка повторно проверяет весь захваченный контекст.
   */
  function send(
    operation: ExitOperation,
    type: DesktopExitCommandType,
    duration: number,
    snapshot?: DesktopExitSnapshot,
  ): Promise<unknown> {
    if (!current(operation)) {
      return Promise.resolve(null);
    }

    return operation.bridge.request({
      type,
      requestId: operation.id,
      expiresAt: Date.now() + duration,
      ...(snapshot ? { snapshot } : {}),
      ...(operation.context.strict ? { strict: true } : {}),
    }, operation.controller.signal);
  }

  /**
   * Вопрос не имеет срока для человека; ограничен каждый отдельный ответ страницы.
   * Один медленный ответ не равен согласию: fallback наступает после трёх промахов.
   */
  async function ask(operation: ExitOperation, snapshot: DesktopExitSnapshot): Promise<boolean> {
    operation.phase = 'prompt';

    const shown = await send(operation, 'prompt', 2000, snapshot);

    if (!isRecord(shown) || shown.ok !== true) {
      await (operation.context.strict ? cancelStrict(operation) : closeNative(operation, false));

      return false;
    }

    let missed = 0;
    let first = true;

    while (current(operation)) {
      if (!first) {
        await delayWithAbort(500, operation.controller.signal);
      }

      first = false;

      const answer = decodeDesktopExitDecision(await send(operation, 'decision', 2000));

      if (!current(operation)) {
        break;
      }

      if (!answer) {
        missed += 1;

        if (missed >= 3) {
          break;
        }

        continue;
      }

      missed = 0;

      if (answer.decision === 'cancel') {
        await send(operation, 'cancel', 2000);
        clear();

        return false;
      }

      if (answer.decision === 'confirm') {
        operation.remember = answer.remember;
        startDeadline(operation);

        return true;
      }
    }

    await (operation.context.strict ? cancelStrict(operation) : closeNative(operation, false));

    return false;
  }

  /**
   * Общий срок начинается после согласия и никогда не продлевается повторным close.
   * Таймер main завершает приложение даже при зависшей странице, записи или cookies.
   */
  function startDeadline(operation: ExitOperation): void {
    operation.phase = 'stopping';
    operation.deadline = setTimeout(() => {
      if (active === operation) {
        if (operation.context.strict) {
          void cancelStrict(operation);

          return;
        }

        options.log(desktopText('desktop.exitDeadline'));
        clear();
        options.exit();
      }
    }, 90000);
  }

  /** Проверяет strict envelope на каждой границе чтения выбранного local origin. */
  async function strictSnapshot(operation: ExitOperation): Promise<DesktopExitSnapshot> {
    const result = decodeStrictDesktopExitInspection(await send(operation, 'inspect', 5000));

    if (!current(operation) || result?.state !== 'ready') {
      throw new Error('release_activity_unknown');
    }

    return result.snapshot;
  }

  /**
   * Пользовательский macOS quit удерживает допуск до последнего доказательства.
   * Внешняя подтверждённая служба остаётся запущенной после закрытия окна.
   */
  async function runStrict(operation: ExitOperation): Promise<void> {
    const initial = await strictSnapshot(operation);
    const hasActivity = initial.chats.length + initial.pipelines.length > 0;

    if (hasActivity && !options.preference().get()) {
      if (!await ask(operation, initial)) {
        return;
      }
    } else {
      startDeadline(operation);
    }

    // Строгий updater ждёт drain-proof дольше общего срока: на время ожидания срок снят.
    const update = options.applyUpdate?.(operation.controller.signal);

    if (update) {
      clearTimeout(operation.deadline);
      operation.deadline = undefined;

      const outcome = await update;

      if (outcome === true || outcome === 'applied') {
        return;
      }
      if (!current(operation) || outcome === 'blocked') {
        throw new Error('release_activity_unknown');
      }

      startDeadline(operation);
    }

    const signal = operation.controller.signal;
    const ownsServer = operation.ownership === 'owned';
    const admission = await options.acquireStrictAdmission?.(signal, ownsServer);

    if (!admission) {
      throw new Error('release_activity_unknown');
    }

    try {
      const fresh = await strictSnapshot(operation);
      const tasks = new Set(initial.pipelines.map(({ task }) => task));
      const chats = new Set(initial.chats.map(({ chatKey }) => chatKey));

      if (fresh.pipelines.some(({ task }) => !tasks.has(task))
        || fresh.chats.some(({ chatKey }) => !chats.has(chatKey))) {
        throw new Error('release_activity_unknown');
      }

      const shown = await send(operation, 'stopping', 2000, fresh);

      if (!current(operation) || !isRecord(shown) || shown.ok !== true) {
        throw new Error('release_activity_unknown');
      }

      const stop = await send(operation, 'stop-pipelines', 20000, fresh);

      if (!current(operation) || !isRecord(stop)
        || Object.keys(stop).join(',') !== 'ok' || stop.ok !== true) {
        throw new Error('release_activity_unknown');
      }

      await admission.confirm(signal);
      await remember(operation);

      if (!current(operation)) {
        throw new Error('release_activity_unknown');
      }
      if (ownsServer) {
        await operation.context.supervisor.stop();
        await admission.proveOwnedServerStopped(signal);
      }

      if (!current(operation, false)) {
        throw new Error('release_activity_unknown');
      }

      await closeNative(operation, true);
    } finally {
      await admission.release().catch(() => {});
    }
  }

  /**
   * Ошибка Remember не запрещает уже подтверждённый выход и остаётся в журнале.
   * Ожидание writer ограничено двумя секундами внутри общего срока остановки.
   */
  async function remember(operation: ExitOperation): Promise<void> {
    if (!operation.remember || !current(operation)) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const writing = options.preference().set(true)
      .catch(() => options.log(desktopText('desktop.exitSaveFailed')));
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2000);
    });

    try {
      await Promise.race([writing, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Сначала подтверждаем кадр модала, затем Stop конвейеров и штатный слив своего сервера.
   * Внешний сервер проходит тот же вопрос и Stop, но слив и строгий updater пропускает:
   * приложению запрещено сигнализировать процессу, которым оно не владеет. Старый quit
   * получает управление только после слива, поэтому труба остаётся живой.
   */
  async function run(operation: ExitOperation): Promise<void> {
    const snapshot = decodeDesktopExitSnapshot(await send(operation, 'inspect', 5000));

    if (!current(operation) || !snapshot || (!snapshot.chats.length && !snapshot.pipelines.length)) {
      await closeNative(operation, false);

      return;
    }

    if (options.preference().get()) {
      startDeadline(operation);
    } else if (!await ask(operation, snapshot)) {
      return;
    }

    const shown = await send(operation, 'stopping', 2000, snapshot);

    if (!current(operation)) {
      await closeNative(operation, false);

      return;
    }

    if (!isRecord(shown) || shown.ok !== true) {
      await closeNative(operation, false);

      return;
    }

    await remember(operation);

    if (current(operation)) {
      const refreshed = decodeDesktopExitSnapshot(await send(operation, 'inspect', 5000)) ?? snapshot;

      await send(operation, 'stopping', 2000, refreshed);

      if (!current(operation)) {
        await closeNative(operation, false);

        return;
      }

      // Строгий updater обещает drain-proof своего сервера; внешний сервер этот путь не проходит.
      const update = operation.ownership === 'owned' ? options.applyUpdate?.() : null;

      if (update) {
        clearTimeout(operation.deadline);
        operation.deadline = undefined;

        const outcome = await update;

        if (outcome === true || outcome === 'applied') {
          return;
        }

        if (!current(operation)) {
          await closeNative(operation, false);

          return;
        }

        startDeadline(operation);
      }

      await send(operation, 'stop-pipelines', 20000, refreshed);
    }

    if (!current(operation)) {
      await closeNative(operation, false);

      return;
    }

    try {
      await operation.context.supervisor.stop();
    } catch {
      options.log(desktopText('desktop.exitServerStopFailed'));
    }

    if (current(operation, false)) {
      await closeNative(operation, true);
    } else {
      await closeNative(operation, false);
    }
  }

  /**
   * Close главного окна и обычный before-quit macOS используют один допуск.
   * Синхронная остановка закрытия сохраняет окно до решения renderer и main.
   */
  function close(event: { preventDefault(): void }): boolean {
    if (nativeClose || options.quitting()) {
      return false;
    }

    if (active) {
      event.preventDefault();

      return true;
    }

    const context = options.context();

    if (!context || !eligible(context)) {
      return false;
    }

    event.preventDefault();

    if (context.strict && (context.window.isMinimized() || !context.window.isVisible())) {
      if (context.window.isMinimized()) {
        context.window.restore();
      }

      context.window.show();
      context.window.focus();
    }

    const operation: ExitOperation = {
      id: randomUUID(),
      context,
      generation: context.supervisor.generation,
      ownership: context.supervisor.ownership,
      bridge: createDesktopExitBridge(context.window, context.origin),
      controller: new AbortController(),
      phase: 'inspecting',
    };

    active = operation;

    const execute = context.strict ? runStrict(operation) : run(operation);

    void execute.catch(() => context.strict ? cancelStrict(operation) : closeNative(operation, false));

    return true;
  }

  return {
    close,
    takeStrictCommit() {
      const committed = strictCommitted;

      strictCommitted = false;

      return committed;
    },
    get finishing() {
      return active?.phase === 'finishing';
    },
    bypass: () => clear(),
    cleanup: () => clear(active?.phase === 'finishing'),
    exited: () => clear(),
  };
}
