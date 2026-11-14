import { createStepSink, type ChatStep } from '../chat/streamSteps.ts';
import { createQwenTextSteps } from './steps.ts';
import { createQwenUsage } from './usage.ts';
import { record } from './transport.ts';

export interface QwenBackgroundHooks {
  onBackgroundStart?: () => void;
  onBackgroundStep?: (step: ChatStep) => void;
  onBackgroundProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onBackground?: (result: Record<string, unknown>) => unknown;
  onBackgroundTasks?: (tasks: Array<{
    id: string;
    kind: 'subagent' | 'monitor' | 'command' | 'other';
    description: string;
  }>) => void;
  onExit?: (event: { reason: string }) => void;
}

/**
 * Фоновый цикл имеет собственные накопители и не пишет в callbacks прошлого HTTP-хода.
 * Финальный flush однократен; завершение подтверждает native lifecycle, не пауза в потоке.
 */
export function createQwenBackground(sessionId: string, hooks: QwenBackgroundHooks) {
  const sink = createStepSink(hooks.onBackgroundStep);
  const text = createQwenTextSteps();
  const usage = createQwenUsage((tokens, info) => hooks.onBackgroundProgress?.(tokens, info));
  const tools = new Set<string>();
  const results = new Set<string>();
  let reply = '';
  let finished = false;

  const emit = (steps: ChatStep[]) => {
    for (const step of steps) {
      sink.emit(step);
    }
  };

  return {
    /**
     * Только нормализованные updates текущей native-сессии попадают в этот коллектор.
     * Инструмент и его итог сохраняются по одному callId, как в обычном ходе.
     */
    observe(value: unknown): void {
      if (finished) {
        return;
      }

      const update = record(value);
      const kind = update.sessionUpdate;
      const part = record(update.content).text;
      const id = String(update.toolCallId || '');

      usage.observe(update);

      if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && typeof part === 'string') {
        const k = kind === 'agent_message_chunk' ? 'text' : 'think';

        emit(text.append(k, part));

        if (k === 'text') {
          reply += part;
        }
      } else if (kind === 'tool_call' && id && !tools.has(id)) {
        emit(text.flush());
        tools.add(id);
        sink.emit({
          k: 'tool',
          id,
          name: update.title,
          input: update.rawInput,
        });
      } else if (kind === 'tool_call_update' && id && !results.has(id)
        && (update.status === 'completed' || update.status === 'failed')) {
        emit(text.flush());
        results.add(id);
        sink.emit({
          k: 'res',
          id,
          text: JSON.stringify(update.content || []),
          ok: update.status === 'completed',
          error: update.status === 'failed',
        });
      }
    },
    /**
     * Только владелец цикла вызывает finish; повторный native end-turn ничего не публикует.
     * Ошибка/отмена остаются видимыми даже когда CLI не успел вывести текст ответа.
     */
    async finish(reason: string): Promise<void> {
      if (finished) {
        return;
      }

      finished = true;
      emit(text.flush());
      await hooks.onBackground?.({
        sessionId,
        reply: reply || (reason === 'cancelled' ? '⏹ Ход остановлен.' : ''),
        steps: sink.steps,
        ...usage.result(),
        ...(reason === 'cancelled' ? { stopped: true } : {}),
      });
    },
  };
}
