import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArbiterModelResult } from '../../server/src/lib/arbiterModelResult.ts';
import { decodeArbiterResult } from '../../shared/pipeline/arbiterConversation.ts';

const targets = [{
  node: 'tests',
  label: 'Тесты',
  executorKind: 'agent',
  acceptsInstruction: true,
  canRetryUnchanged: false,
  resetNodes: ['tests', 'build'],
}];
const modelResult = {
  summary: 'Не запустились проверки окружения.',
  questions: [{
    id: 'q1',
    text: 'Как восстановить окружение?',
    options: [{
      id: 'restore',
      label: 'Восстановить версию',
      description: 'Сохранить прежнюю настройку.',
    }],
    allowCustom: true,
  }],
  proposals: [{
    id: 'diagnose',
    kind: 'diagnose',
    label: 'Проверить окружение',
    recommended: true,
    expectedResult: 'Будут известны предусловия запуска.',
    diagnosticInstruction: 'Прочитай конфигурацию.',
  }, {
    id: 'replay',
    kind: 'apply',
    label: 'Повторить тесты',
    recommended: false,
    expectedResult: 'Тесты выполнятся с исправленным окружением.',
    action: {
      kind: 'replay_current',
      targetNode: 'tests',
      instruction: 'Проверь запуск обязательных скриптов.',
    },
  }],
  technicalDetails: '',
};

test('модельные description и пропущенные пояснения сохраняют вопросы и проверенные действия', () => {
  const before = structuredClone(modelResult);
  const canonical = parseArbiterModelResult(JSON.stringify(modelResult), targets, 'tests');

  assert.deepEqual(canonical.questions[0].options, [{ id: 'restore', label: 'Восстановить версию' }]);
  assert.equal(canonical.proposals.length, 2);
  assert.deepEqual(canonical.proposals.map((proposal) => proposal.recommended), [true, false]);
  assert.equal(canonical.proposals[0].explanation, modelResult.proposals[0].expectedResult);
  assert.deepEqual(canonical.proposals[1].action, modelResult.proposals[1].action);
  assert.deepEqual(decodeArbiterResult(canonical, targets, 'tests'), canonical);
  assert.throws(() => decodeArbiterResult(modelResult, targets, 'tests'));
  assert.deepEqual(modelResult, before);
});

test('пропущенный recommended у неприоритетных diagnose и apply заполняется false', () => {
  const row = parseArbiterModelResult(JSON.stringify(modelResult), targets, 'tests');

  row.proposals.splice(1, 0, { ...row.proposals[0], id: 'other_diagnose' });
  delete row.proposals[1].recommended;
  delete row.proposals[2].recommended;

  const expected = structuredClone(row);

  expected.proposals[1].recommended = false;
  expected.proposals[2].recommended = false;

  assert.throws(() => decodeArbiterResult(row, targets, 'tests'), { code: 'invalid_request' });

  const canonical = parseArbiterModelResult(JSON.stringify(row), targets, 'tests');

  assert.deepEqual(canonical, expected);
  assert.deepEqual(decodeArbiterResult(canonical, targets, 'tests'), canonical);
});

test('явный не-булевый recommended у diagnose и apply отклоняет весь итог', () => {
  for (const index of [0, 1]) {
    for (const recommended of [null, 'false', 'true', 0, 1, [], {}]) {
      const row = structuredClone(modelResult);

      row.proposals[index].recommended = recommended;

      assert.throws(() => parseArbiterModelResult(JSON.stringify(row), targets, 'tests'),
        { code: 'bad_model_reply' });
    }
  }
});

test('модельные послабления не принимают неизвестные поля, цели и повреждённые указания', () => {
  const mutations = [
    (row) => {
      row.command = 'outside';
    },
    (row) => {
      row.questions[0].options[0].command = 'outside';
    },
    (row) => {
      row.questions[0].options[0].description = { action: 'outside' };
    },
    (row) => {
      row.questions[0].options[0].description = 'x'.repeat(2001);
    },
    (row) => {
      row.questions[0].options.push(row.questions[0].options[0]);
    },
    (row) => {
      row.proposals[0].explanation = '';
    },
    (row) => {
      row.proposals[0].explanation = null;
    },
    (row) => {
      delete row.proposals[0].expectedResult;
    },
    (row) => {
      row.proposals[0].action = row.proposals[1].action;
    },
    (row) => {
      row.proposals[1].action.targetNode = 'future';
    },
    (row) => {
      row.proposals[1].action.command = 'outside';
    },
    (row) => {
      row.proposals[1].action.instruction = 'bad\0instruction';
    },
    (row) => {
      delete row.proposals[1].action;
    },
  ];

  for (const mutate of mutations) {
    const row = structuredClone(modelResult);

    mutate(row);
    assert.throws(() => parseArbiterModelResult(JSON.stringify(row), targets, 'tests'),
      { code: 'bad_model_reply' });
  }
});

test('ошибка JSON не публикует фрагмент служебного ответа модели', () => {
  assert.throws(() => parseArbiterModelResult('{"SECRET": broken}', targets, 'tests'), (error) => {
    assert.equal(error.code, 'bad_model_reply');
    assert.equal(error.message.includes('SECRET'), false);

    return true;
  });
});
