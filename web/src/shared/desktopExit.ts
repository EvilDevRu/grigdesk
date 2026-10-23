import { nextTick, reactive } from 'vue';

import { decodeDesktopExitCommand } from '../../../shared/desktop/desktopExitContract.ts';
import type {
  DesktopExitDecision, DesktopExitSnapshot,
} from '../../../shared/desktop/desktopExitContract.ts';
import { inspectDesktopExitActivity, stopDesktopExitPipelines } from './desktopExitActivity.ts';
import type { PipelineExitResult } from './desktopExitActivity.ts';

declare global {
  interface Window {
    grigdeskDesktopExit?: (command: unknown) => Promise<unknown>;
  }
}

/**
 * Документ владеет одним модалом и фиксированным набором команд от main.
 * Этот host не связан с авторизацией и online, поэтому слив сервера его не размонтирует.
 */
export function createDesktopExitRenderer(options: {
  sessions(): readonly { id: string; title?: string }[];
}) {
  const state = reactive({
    phase: 'idle' as 'idle' | 'prompt' | 'stopping',
    snapshot: { chats: [], pipelines: [] } as DesktopExitSnapshot,
    remember: false,
    results: [] as PipelineExitResult[],
  });
  const retired = new Set<string>();
  let requestId: string | null = null;
  let decision: DesktopExitDecision = { decision: 'pending' };
  let lifetime = new AbortController();
  let stopping: Promise<unknown> | null = null;
  let disposed = false;

  /**
   * Отмена закрывает только диалог: API работы чатов и конвейеров здесь не вызываются.
   * Флажок возвращается main исключительно вместе с явным согласием человека.
   */
  function choose(confirm: boolean): void {
    if (state.phase !== 'prompt') {
      return;
    }

    decision = confirm ? { decision: 'confirm', remember: state.remember } : { decision: 'cancel' };

    if (!confirm) {
      state.phase = 'idle';
    }
  }

  /**
   * Освобождение запроса запрещает его поздним командам запустить Stop.
   * Уже отправленные серверу остановки остаются штатными операциями сервера.
   */
  function clear(): void {
    if (requestId) {
      retired.add(requestId);
    }

    requestId = null;
    lifetime.abort();
    lifetime = new AbortController();
    stopping = null;
    state.phase = 'idle';
    state.remember = false;
    state.results = [];
    decision = { decision: 'pending' };
  }

  /**
   * Inspect ограничивает всю цепочку чтения, включая недостающие названия чатов.
   * По сроку возвращается unavailable, а поздние сетевые ответы не меняют модал.
   */
  async function inspect(expiresAt: number): Promise<unknown> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, Math.max(0, Math.min(5000, expiresAt - Date.now())));
    const unavailable = new Promise<{ unavailable: true }>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve({ unavailable: true }), { once: true });
    });

    lifetime.signal.addEventListener('abort', cancel, { once: true });

    try {
      return await Promise.race([
        inspectDesktopExitActivity(options.sessions(), controller.signal), unavailable,
      ]);
    } finally {
      clearTimeout(timer);
      lifetime.signal.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  /**
   * Быстрые ACK не ждут человека: decision опрашивается главным процессом отдельно.
   * Повторы prompt и stopping сохраняют ввод и DOM уже показанного модала.
   */
  async function dispatch(value: unknown): Promise<unknown> {
    const command = decodeDesktopExitCommand(value, Date.now());

    if (disposed || !command || retired.has(command.requestId)
      || (requestId && requestId !== command.requestId)
      || (!requestId && !['inspect', 'prompt', 'stopping'].includes(command.type))) {
      return { unavailable: true };
    }

    requestId = command.requestId;

    switch (command.type) {
      case 'inspect':
        return inspect(command.expiresAt);
      case 'prompt':
        if (state.phase === 'idle' && decision.decision === 'pending') {
          state.snapshot = command.snapshot!;
          state.phase = 'prompt';
        }

        return { ok: true };
      case 'decision':
        return { ...decision };
      case 'cancel':
        clear();

        return { ok: true };
      case 'stopping':
        state.snapshot = command.snapshot!;
        state.phase = 'stopping';
        await nextTick();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

        return { ok: true };
      case 'stop-pipelines':
        if (state.phase !== 'stopping') {
          return { unavailable: true };
        }

        stopping ??= stopDesktopExitPipelines(state.snapshot.pipelines, command.expiresAt, lifetime.signal)
          .then((results) => {
            if (requestId === command.requestId && !disposed) {
              state.results = results;
            }

            return { ok: results.every((result) => result.state === 'stopped'), results };
          });

        return stopping;
    }
  }

  return {
    state,
    dispatch,
    choose,
    dispose() {
      disposed = true;
      clear();
    },
  };
}
