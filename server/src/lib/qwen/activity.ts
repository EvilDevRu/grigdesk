import type { ChatSessionActivity } from '../../../../shared/chat/chatSessionActivity.ts';
import { record } from './transport.ts';

export const QWEN_IDLE_STATUS_METHOD = 'qwen/status/session/grigdesk-idle-status-v1';
export const QWEN_IDLE_CLOSE_METHOD = 'qwen/control/session/grigdesk-idle-close-v1';
export const QWEN_IDLE_POLL_MS = 5000;

const REASONS = new Set(['turn', 'subagent', 'command', 'monitor', 'workflow', 'schedule', 'goal']);

export const unknownQwenActivity = (): ChatSessionActivity => ({
  state: 'unknown', reasons: [{ kind: 'unknown' }],
});

/**
 * Idle допускается только по полному versioned ответу собственной native сессии.
 * Неизвестный формат и повреждённая причина сохраняют защиту от закрытия.
 */
export function decodeQwenActivity(value: unknown, sessionId: string): ChatSessionActivity {
  const snapshot = record(value);

  if (!sessionId || snapshot.v !== 1 || snapshot.sessionId !== sessionId
    || !['idle', 'busy'].includes(String(snapshot.state))
    || !Array.isArray(snapshot.reasons) || snapshot.reasons.length > 64) {
    return unknownQwenActivity();
  }

  const reasons: ChatSessionActivity['reasons'] = [];

  for (const raw of snapshot.reasons) {
    const reason = record(raw);

    if (!REASONS.has(String(reason.kind))
      || !Number.isSafeInteger(reason.count) || Number(reason.count) < 1
      || (reason.nextAt !== undefined
        && (typeof reason.nextAt !== 'number' || !Number.isFinite(reason.nextAt)))) {
      return unknownQwenActivity();
    }

    reasons.push({
      kind: reason.kind as ChatSessionActivity['reasons'][number]['kind'],
      count: Number(reason.count),
      ...(typeof reason.nextAt === 'number' ? { nextAt: reason.nextAt } : {}),
    });
  }

  if ((snapshot.state === 'idle') !== (reasons.length === 0)) {
    return unknownQwenActivity();
  }

  return { state: snapshot.state as 'idle' | 'busy', reasons };
}
