// Проверяет приоритеты состояния и индикатора внимания компаньона.
import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceCompanionState } from '../../web/src/features/companion/attention.js';

test('COMP-ATTN-01/02/07: interaction — отдельная ось с точным приоритетом', () => {
  const state = reduceCompanionState({
    interaction: {
      listening: true, transcribing: true, speaking: true, thinking: true, open: true,
    },
    chat: { id: 'c1', unread: true },
  });

  assert.equal(state.interaction, 'listening');
  assert.equal(state.attention.kind, 'info', 'interaction не стирает badge непрочитанного');
  assert.equal(reduceCompanionState({ interaction: { transcribing: true, speaking: true } }).interaction, 'transcribing');
  assert.equal(reduceCompanionState({ interaction: { speaking: true, thinking: true } }).interaction, 'speaking');
  assert.equal(reduceCompanionState({ interaction: { thinking: true, open: true } }).interaction, 'thinking');
  assert.equal(reduceCompanionState({ interaction: { open: true } }).interaction, 'open');
  assert.equal(reduceCompanionState({}).interaction, 'idle');
});

test('COMP-ATTN-03/05/08: stall > wait > info, task counts дедуплицированы', () => {
  const state = reduceCompanionState({
    pipeline: {
      stalled: [{ task: 1 }, { task: '1' }],
      silent: [{ task: 2 }],
      waiting: [{ task: 3 }, { task: '3' }],
      running: [{ task: 1 }, { task: 4 }],
    },
  });

  assert.equal(state.attention.kind, 'stall');
  assert.equal(state.attention.count, 2, 'stalled+silent считаются один раз на задачу');
  assert.deepEqual(state.attention.taskIds, ['1', '2']);

  const wait = reduceCompanionState({ pipeline: { waiting: [{ task: 3 }], running: [{ task: 4 }] } });
  assert.equal(wait.attention.kind, 'wait');
  assert.equal(wait.attention.count, 1);

  const info = reduceCompanionState({ pipeline: { running: [{ task: 4 }, { task: '4' }] } });
  assert.equal(info.attention.kind, 'info');
  assert.equal(info.attention.count, 1);

  const none = reduceCompanionState({ pipeline: { stalled: [], silent: [], waiting: [], running: [] } });
  assert.equal(none.attention.kind, 'none');
});

test('COMP-ATTN-04/06: exact permission/question даёт wait и deep link, unread — info', () => {
  const waiting = reduceCompanionState({
    chat: {
      id: 'companion-1', unread: true,
      pending: [
        { chatKey: 'other', kind: 'perm' },
        { chatKey: 'companion-1', kind: 'question' },
      ],
    },
  });
  assert.equal(waiting.attention.kind, 'wait');
  assert.equal(waiting.attention.chatId, 'companion-1');

  const unread = reduceCompanionState({ chat: { id: 'companion-1', unread: true, pending: [] } });
  assert.equal(unread.attention.kind, 'info');
  assert.equal(unread.attention.chatId, 'companion-1');
});

test('COMP-ATTN-09: reducer не вызывает переданные effects', () => {
  let calls = 0;
  reduceCompanionState({
    pipeline: { running: [{ task: 4 }] },
    effects: { api: () => { calls += 1; }, notify: () => { calls += 1; }, router: () => { calls += 1; } },
  });
  assert.equal(calls, 0);
});
