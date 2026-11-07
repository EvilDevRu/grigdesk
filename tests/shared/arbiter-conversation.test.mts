import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeArbiterResult,
  decodeHumanIntent,
  decodeStopIdentity,
  invalidateDecision,
} from '../../shared/pipeline/arbiterConversation.ts';
import type { ArbiterTarget } from '../../shared/pipeline/arbiterConversation.ts';

const stop = {
  task: '123',
  profile: 'sample',
  attempt: `a_${'a'.repeat(32)}`,
  node: 'verify',
  stop: 'human',
  stageSequence: 3,
  stageHeadHash: 'b'.repeat(64),
};

const targets: ArbiterTarget[] = [
  {
    node: 'build',
    label: 'Исправление',
    executorKind: 'agent',
    acceptsInstruction: true,
    canRetryUnchanged: false,
    resetNodes: ['build', 'verify']
  },
  {
    node: 'verify',
    label: 'Проверка',
    executorKind: 'command',
    acceptsInstruction: false,
    canRetryUnchanged: true,
    resetNodes: ['verify']
  },
];

const question = {
  id: 'q1',
  text: 'Где прервалась проверка?',
  options: [],
  allowCustom: true
};
const proposal = {
  id: 'p1',
  kind: 'apply',
  label: 'Исправить проверки',
  explanation: 'Вернуться к автору.',
  recommended: true,
  expectedResult: 'Этап получит указание.',
  action: {
    kind: 'return_to_node',
    targetNode: 'build',
    instruction: 'Проверь журнал целиком.'
  },
};

test('результат допускает вопрос без предложения и серверный выбор допустимой цели', () => {
  const result = {
    summary: 'Проверка не завершилась. Нужно выяснить причину.',
    questions: [question],
    proposals: [],
    technicalDetails: ''
  };

  assert.deepEqual(decodeArbiterResult(result, targets, stop.node), result);
  assert.equal(decodeArbiterResult({ ...result, proposals: [proposal] }, targets, stop.node)
    .proposals[0]!.kind, 'apply');
});

test('итог без вопросов предлагает выбор, а без вопросов и предложений явно продолжает диалог', () => {
  const base = {
    summary: 'Решение учтено. Выберите, как продолжить.',
    questions: [],
    proposals: [proposal],
    technicalDetails: '',
  };

  for (const nextStep of [undefined, 'choose_proposal']) {
    const row = nextStep ? { ...base, nextStep } : base;

    assert.deepEqual(decodeArbiterResult(row, targets, stop.node), row);
  }

  const finished = {
    ...base,
    proposals: [],
    nextStep: 'continue_discussion',
  };

  assert.deepEqual(decodeArbiterResult(finished, targets, stop.node), finished);

  for (const row of [
    { ...base, nextStep: 'answer_questions' },
    { ...base, nextStep: 'continue_discussion' },
    { ...base, nextStep: 'applying' },
    { ...finished, nextStep: 'choose_proposal' },
    { ...finished, nextStep: null },
    { ...finished, questions: [question] },
  ]) {
    assert.throws(() => decodeArbiterResult(row, targets, stop.node));
  }
});

test('строгая схема запрещает неизвестные поля, команды, повторы id и неподходящую цель', () => {
  const base = {
    summary: 'Причина ещё неизвестна.',
    questions: [question],
    proposals: [proposal],
    technicalDetails: ''
  };

  for (const invalid of [
    { ...base, summary: '' },
    { ...base, summary: 'x'.repeat(2001) },
    { ...base, command: 'rm -rf /' },
    { ...base, questions: [question, question] },
    {
      ...base,
      questions: [],
      proposals: []
    },
    { ...base, proposals: [{ ...proposal, kind: 'shell' }] },
    { ...base, proposals: [{ ...proposal, action: { ...proposal.action, targetNode: 'future' } }] },
    { ...base, proposals: [{ ...proposal, action: { ...proposal.action, targetNode: 'verify' } }] },
    {
      ...base, proposals: [{
        ...proposal,
        action: {
          kind: 'retry_command',
          targetNode: 'verify',
          instruction: 'Увеличь лимит'
        }
      }]
    },
  ]) {
    assert.throws(() => decodeArbiterResult(invalid, targets, stop.node));
  }
});

test('обсуждение не несёт action; применение требует явного выбора', () => {
  assert.deepEqual(decodeHumanIntent('discuss', { text: 'Что известно?' }), { text: 'Что известно?' });
  assert.throws(() => decodeHumanIntent('discuss', { text: 'Выполни', action: proposal.action }));
  assert.throws(() => decodeHumanIntent('apply', {}));
  assert.throws(() => decodeHumanIntent('discuss', { text: 'x'.repeat(16001) }));
  assert.throws(() => decodeStopIdentity({ ...stop, stageHeadHash: undefined }));
  assert.deepEqual(decodeStopIdentity(stop), stop);
});

test('новый ход немедленно инвалидирует решение; ошибка не возвращает предложения', () => {
  const decision = invalidateDecision({ decisionRevision: 4, result: { proposals: [proposal] } });

  assert.equal(decision.decisionRevision, 5);
  assert.equal(decision.result, null);
});
