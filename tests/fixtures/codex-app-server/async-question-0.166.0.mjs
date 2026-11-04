#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Форма agentMessage закреплена схемой установленного Codex CLI 0.166.0.
export const COMPATIBILITY = {
  cli: '0.166.0',
  schema: 'ItemCompletedNotification.ThreadItem.agentMessage',
};

const scenario = process.env.GRIGDESK_ASYNC_QUESTION_SCENARIO || 'hold';
const trace = process.env.GRIGDESK_ASYNC_QUESTION_TRACE;
const threadId = 'synthetic-thread';
let turnNumber = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Один native item сохраняет поля async и questions рядом с уже готовым текстом.
 * Повторы используют тот же ID; новый ход намеренно может повторно использовать этот ID.
 */
function question(ownerThread = threadId, ownerTurn = `turn-${turnNumber}`) {
  send({
    method: 'item/completed',
    params: {
      threadId: ownerThread,
      turnId: ownerTurn,
      item: {
        type: 'agentMessage',
        id: 'async-question',
        text: scenario === 'empty-text' ? '' : 'Разрешить диагностику?\n- Разрешить\n- Только журналы',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: 'Разрешить диагностику?', options: ['Разрешить', 'Только журналы'] }],
      },
    },
  });
}

/**
 * Завершение принадлежит текущему ходу, а финальный текст отличается от вопроса.
 * Так проверяется, что вопрос не подменяет итог и не удерживает завершённую карточку.
 */
function finish(status = 'completed', final = true) {
  if (status === 'completed' && final) {
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId: `turn-${turnNumber}`,
        item: {
          type: 'agentMessage',
          id: 'final-answer',
          text: 'Исходная задача завершена.',
          phase: 'final_answer',
        },
      },
    });
  }

  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: `turn-${turnNumber}`, status } },
  });
}

/**
 * Фикстура сохраняет клиентские RPC и отвечает без модели и внешних ресурсов.
 * Независимый commentary приходит до решения человека, а steer завершает тот же ход.
 */
function consume(message) {
  appendFileSync(trace, `${JSON.stringify(message)}\n`);

  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: {
      thread: { id: threadId },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: { type: 'workspaceWrite' },
    } });
  } else if (message.method === 'turn/start') {
    turnNumber += 1;
    send({ id: message.id, result: { turn: { id: `turn-${turnNumber}` } } });

    if (scenario === 'foreign' || scenario === 'unscoped') {
      if (scenario === 'unscoped') {
        question('', '');
      }

      question('foreign-thread');
      question(threadId, 'foreign-turn');
      finish();

      return;
    }

    question();

    if (scenario === 'duplicate') {
      question();
    }
    if (scenario === 'completed' || scenario === 'question-only') {
      finish('completed', scenario !== 'question-only');

      return;
    }

    send({ method: 'item/completed', params: {
      threadId,
      turnId: `turn-${turnNumber}`,
      item: {
        type: 'agentMessage',
        id: 'independent-work',
        text: 'Продолжаю независимую проверку.',
        phase: 'commentary',
      },
    } });
  } else if (message.method === 'turn/steer') {
    if (scenario === 'reject-steer') {
      send({ id: message.id, error: { code: -32602, message: 'Синтетический отказ доставки' } });
    } else {
      send({ id: message.id, result: { turnId: `turn-${turnNumber}` } });
      finish();
    }
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    finish('interrupted');
  }
}

createInterface({ input: process.stdin }).on('line', (line) => consume(JSON.parse(line)));
