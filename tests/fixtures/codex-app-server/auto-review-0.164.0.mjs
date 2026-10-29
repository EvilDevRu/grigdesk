// Native Auto-review закреплён схемой CLI 0.164.0 отдельно от старых rich events.
// Общий transport проверяет hooks и lifecycle; этот модуль задаёт только новые события.
import { writeFileSync } from 'node:fs';
import { runFixture } from './rich-turn-0.149.0.mjs';

export const AUTO_REVIEW_METHOD = 'item/autoApprovalReview/completed';

/**
 * Минимальный completed payload соответствует установленной схеме 0.164.0.
 * Причина есть только здесь: финальный ответ fixture её никогда не повторяет.
 */
export function reviewEvent(threadId, turnId, overrides = {}) {
  return {
    method: AUTO_REVIEW_METHOD,
    params: {
      threadId,
      turnId,
      startedAtMs: 1_700_000_001_000,
      completedAtMs: 1_700_000_001_100,
      reviewId: 'review-1',
      targetItemId: 'command-reviewed',
      decisionSource: 'agent',
      action: {
        type: 'command',
        source: 'shell',
        command: 'git add -- allowed.txt',
        cwd: '/fixture',
      },
      ...overrides,
      review: {
        status: 'denied',
        riskLevel: null,
        userAuthorization: null,
        rationale: 'Тестовый отказ reviewer',
        ...overrides.review,
      },
    },
  };
}

/**
 * Сценарии моделируют только протокол: они не доказывают файловые права Codex.
 * Неподдерживаемый request специально оставляет процесс живым для проверки остановки.
 */
export function runAutoReviewFixture() {
  const scenario = process.env.GRIGDESK_CODEX_FIXTURE_SCENARIO || 'reviews';
  const effectiveSettings = JSON.parse(process.env.GRIGDESK_CODEX_EFFECTIVE_SETTINGS || '{}');
  let previousTurnId = 'stale-turn';

  runFixture({
    effectiveSettings,
    onBeforeTurn({ send, activeTurn, threadId }) {
      if (scenario !== 'early-manual') {
        return;
      }

      send({
        id: 91640,
        method: 'item/permissions/requestApproval',
        params: {
          threadId,
          turnId: activeTurn.id,
        },
      });
    },
    /**
     * Подмешиваем решения reviewer или неподдерживаемые ручные запросы.
     * Поздний marker доказывает остановку процесса, а не только локального Promise.
     */
    onTurn({ send, activeTurn, threadId }) {
      const turnId = activeTurn.id;
      const finish = () => {
        send({ method: 'item/completed', params: {
          threadId,
          turnId,
          item: {
            type: 'agentMessage',
            id: `final-${turnId}`,
            phase: 'final_answer',
            text: 'Ход завершён',
          },
        } });
        send({ method: 'turn/completed', params: {
          threadId,
          turn: { ...activeTurn, status: 'completed' },
        } });
      };

      if (scenario === 'early-manual') {
        process.on('SIGTERM', () => {});
        setTimeout(() => writeFileSync(process.env.GRIGDESK_CODEX_EFFECT_MARKER, 'late effect'), 200);
        setTimeout(finish, 230);

        return;
      }

      if (scenario.startsWith('manual-')) {
        const [, kind, owner = 'own'] = scenario.split('-');
        const method = {
          command: 'item/commandExecution/requestApproval',
          file: 'item/fileChange/requestApproval',
          permissions: 'item/permissions/requestApproval',
        }[kind];
        const params = owner === 'missing' ? {} : {
          threadId: owner === 'thread' ? 'foreign-thread' : threadId,
          turnId: owner === 'turn' ? 'foreign-turn' : turnId,
        };

        send({
          id: 91640,
          method,
          params,
        });

        if (owner === 'own' || owner === 'missing') {
          process.on('SIGTERM', () => {});
          setTimeout(() => writeFileSync(process.env.GRIGDESK_CODEX_EFFECT_MARKER, 'late effect'), 200);
        } else {
          setTimeout(finish, 30);
        }

        return;
      }

      send(reviewEvent('foreign-thread', turnId));
      send(reviewEvent(threadId, previousTurnId));

      const approved = reviewEvent(threadId, turnId, {
        reviewId: 'approved',
        review: { status: 'approved', rationale: null },
      });

      send({ method: 'item/started', params: {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: 'command-reviewed',
          command: 'git add -- allowed.txt',
        },
      } });
      send({ ...approved, method: 'item/autoApprovalReview/started' });
      send(approved);
      send({ method: 'item/completed', params: {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: 'command-reviewed',
          exitCode: 0,
          aggregatedOutput: 'OK',
        },
      } });

      for (const status of ['denied', 'timedOut', 'aborted']) {
        const event = reviewEvent(threadId, turnId, {
          reviewId: status,
          targetItemId: null,
          review: { status, rationale: status === 'denied' ? 'Тестовый отказ reviewer' : null },
        });

        send(event);
        send(event);
      }

      previousTurnId = turnId;
      finish();
    },
  });
}
