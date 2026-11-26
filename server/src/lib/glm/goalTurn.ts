import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import type { ChatStep } from '../chat/streamSteps.ts';
import type { DeepSeekWebClient } from '../deepseek/serverClient.ts';
import { glmAccessError } from './env.ts';

/**
 * Явную команду человека исполняет хост через штатный RPC Harness.
 * Модель по своему инструменту не может возобновить приостановленную цель.
 */
export async function resumeGlmGoal(client: DeepSeekWebClient, sessionId: string, signal?: AbortSignal) {
  const goal = recordOrEmpty(await client.rpc('goals/get', { agentId: sessionId }, 5000, signal));

  if (typeof goal.id !== 'string' || !Number.isSafeInteger(goal.revision)) {
    throw glmAccessError('glm_goal_missing', 'В этом разговоре нет сохранённой цели.');
  }
  if (goal.phase === 'complete') {
    throw glmAccessError('glm_goal_complete', 'Цель уже завершена. Можно поставить новую.');
  }
  if (Number(goal.roundsStarted) >= Number(goal.maxGoalRounds)) {
    throw glmAccessError('glm_goal_limit', 'Цель исчерпала лимит раундов.');
  }

  await client.rpc('goals/resume', {
    agentId: sessionId,
    ref: { id: goal.id, revision: goal.revision },
  }, 5000, signal);
}

/**
 * Учитывает только новые события родительской сессии. Сохранённая или остановленная
 * цель оживает после явного resume, который Harness подтверждает собственным событием.
 */
export function createGlmGoalTurn() {
  let active = false;
  let total = 0;

  return {
    isActive: () => active,
    inspect(event: Record<string, unknown>, emit: (step: ChatStep) => void) {
      const data = recordOrEmpty(event.data);

      if (event.type === 'user/message' && active) {
        const source = recordOrEmpty(data.source);
        if (source.kind === 'goal') {
          emit({ k: 'note', label: 'goalRound', round: Number(source.round), total });
        }

        return;
      }
      if (event.type !== 'goal/change') {
        return;
      }

      const goal = recordOrEmpty(data.goal);
      const phase = goal.phase;

      if (data.operation === 'create' || data.operation === 'resume') {
        active = phase === 'active';
      } else if (phase !== 'active') {
        active = false;
      }

      total = Number(goal.maxGoalRounds) || 0;
      const blocker = recordOrEmpty(goal.blockedReason);

      emit({
        k: 'note',
        label: 'goalState',
        phase: typeof phase === 'string' ? phase : 'cleared',
        round: Number(data.roundsStarted) || 0,
        total,
        reasonCode: blocker.code === 'round-limit' ? 'round-limit' : undefined,
        text: typeof blocker.message === 'string' ? blocker.message.slice(0, 280) : '',
      });
    },
  };
}
