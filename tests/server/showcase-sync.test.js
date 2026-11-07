// Смысловые привязки речи: серверные хеши, UTF-16 диапазоны и допустимые
// сочетания cue с действиями. Устаревшая связь остаётся читаемой, но никогда не
// переинтерпретируется относительно уже изменённого текста или порядка действий.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNarration } from '../../shared/plugins/showcase/showcaseNarration.ts';
import {
  SHOWCASE_SYNC_ACTIONS_BY_CUE,
  validateShowcaseSyncBindings,
} from '../../shared/plugins/showcase/showcaseSync.ts';
import {
  createScene,
  createSyncBindings,
  patchScene,
  sceneSyncBindingsState,
  syncActionsHash,
  syncTextHash,
} from '../../server/src/lib/showcase/scenes.ts';

const NARRATION = 'з+амок  открыт\n😀 замок и ёлка видны, замок подсвечен.';
const CANONICAL = 'замок открыт 😀 замок и ёлка видны, замок подсвечен.';
const ACTIONS = [
  { kind: 'click', targetId: 'open' },
  { kind: 'waitVisible', targetId: 'result' },
  { kind: 'highlight', targetId: 'result' },
];
const CUES = [
  { actionIndex: 0, from: 0, to: 5, kind: 'align-start', origin: 'manual' },
  { actionIndex: 1, from: 16, to: 34, kind: 'ready-before', origin: 'generated' },
  { actionIndex: 2, from: 36, to: 51, kind: 'hold-through', origin: 'manual' },
];

function bindingsFixture() {
  return createSyncBindings(NARRATION, ACTIONS, CUES);
}

function validate(bindings, overrides = {}) {
  return validateShowcaseSyncBindings({
    bindings,
    canonicalText: CANONICAL,
    actions: ACTIONS,
    expectedTextHash: syncTextHash(NARRATION),
    expectedActionsHash: syncActionsHash(ACTIONS),
    ...overrides,
  });
}

function replaceCue(bindings, index, patch) {
  return {
    ...bindings,
    cues: bindings.cues.map((cue, cueIndex) => (
      cueIndex === index ? { ...cue, ...patch } : cue
    )),
  };
}

test('таблица первой версии разрешает только согласованные виды действий', () => {
  assert.deepEqual(SHOWCASE_SYNC_ACTIONS_BY_CUE, {
    'align-start': ['goto', 'click', 'hover', 'scroll'],
    'ready-before': ['waitVisible'],
    'hold-through': ['highlight'],
  });
  assert.ok(
    Object.values(SHOWCASE_SYNC_ACTIONS_BY_CUE).every((actions) => !actions.includes('wait')),
  );
});

test('сервер создаёт три однозначные привязки в координатах канонического текста', () => {
  const parsed = parseNarration(NARRATION);
  const bindings = bindingsFixture();
  const occurrences = [...parsed.text.matchAll(/замок/giu)].map((match) => match.index);

  assert.equal(parsed.text, CANONICAL);
  assert.deepEqual(occurrences, [0, 16, 36], 'emoji занимает две позиции UTF-16');
  assert.deepEqual(
    bindings.cues.map((cue) => parsed.text.slice(cue.from, cue.to)),
    ['замок', 'замок и ёлка видны', 'замок подсвечен'],
  );
  assert.equal(new Set(bindings.cues.map((cue) => cue.id)).size, 3);
  assert.ok(bindings.cues.every((cue) => /^cue-[a-f0-9]{12}$/.test(cue.id)));
  assert.deepEqual(validate(bindings), { status: 'valid', issues: [] });
});

test('хеш текста использует каноническую строку, но не меняет ё и обычный плюс', () => {
  assert.equal(syncTextHash(NARRATION), syncTextHash(CANONICAL));
  assert.equal(syncTextHash('з+амок  открыт\n'), syncTextHash('замок открыт'));
  assert.notEqual(syncTextHash('2+2'), syncTextHash('22'));
  assert.notEqual(syncTextHash('всё'), syncTextHash('все'));
});

test('хеш действий учитывает полный принятый массив и его порядок', () => {
  const sameActionsWithOtherKeyOrder = ACTIONS.map((action) => ({
    targetId: action.targetId,
    kind: action.kind,
  }));

  assert.equal(syncActionsHash(ACTIONS), syncActionsHash(sameActionsWithOtherKeyOrder));
  assert.notEqual(syncActionsHash(ACTIONS), syncActionsHash([ACTIONS[1], ACTIONS[0], ACTIONS[2]]));
  assert.notEqual(
    syncActionsHash(ACTIONS),
    syncActionsHash([{ ...ACTIONS[0], targetId: 'other' }, ACTIONS[1], ACTIONS[2]]),
  );
});

test('правка текста и перестановка действий делают связь stale до проверки диапазонов', () => {
  const bindings = replaceCue(bindingsFixture(), 0, { from: 999, to: 1000 });
  const textResult = validate(bindings, { expectedTextHash: syncTextHash(`${NARRATION} ещё`) });
  const reordered = [ACTIONS[1], ACTIONS[0], ACTIONS[2]];
  const actionsResult = validate(bindings, { expectedActionsHash: syncActionsHash(reordered) });

  assert.equal(textResult.status, 'stale');
  assert.deepEqual(textResult.issues.map((item) => item.code), ['text_hash_mismatch']);
  assert.equal(actionsResult.status, 'stale');
  assert.deepEqual(actionsResult.issues.map((item) => item.code), ['actions_hash_mismatch']);
});

test('границы диапазона называют пустоту, выход, пробел и разрезанный emoji отдельно', () => {
  const bindings = bindingsFixture();
  const cases = [
    [{ from: 5, to: 5 }, 'range_empty'],
    [{ from: -1, to: 5 }, 'range_out_of_bounds'],
    [{ from: 0, to: CANONICAL.length + 1 }, 'range_out_of_bounds'],
    [{ from: 14, to: 20 }, 'range_splits_surrogate'],
    [{ from: 5, to: 6 }, 'empty_text_range'],
  ];

  for (const [patch, code] of cases) {
    const result = validate(replaceCue(bindings, 0, patch));

    assert.equal(result.status, 'invalid');
    assert.ok(result.issues.some((item) => item.code === code), code);
  }
});

test('индекс, ID и сочетание вида связи с действием проверяются явно', () => {
  const bindings = bindingsFixture();
  const invalidIndex = validate(replaceCue(bindings, 0, { actionIndex: ACTIONS.length }));
  const duplicateId = validate(replaceCue(bindings, 1, { id: bindings.cues[0].id }));
  const emptyId = validate(replaceCue(bindings, 0, { id: '   ' }));
  const unsupported = validate(replaceCue(bindings, 0, { kind: 'ready-before' }));
  const duplicateAction = validate({
    ...bindings,
    cues: [
      bindings.cues[0],
      {
        ...bindings.cues[0],
        id: 'cue-same-action-again',
        from: 16,
        to: 21,
      },
    ],
  });

  assert.ok(invalidIndex.issues.some((item) => item.code === 'action_index_out_of_bounds'));
  assert.ok(duplicateId.issues.some((item) => item.code === 'duplicate_cue_id'));
  assert.ok(emptyId.issues.some((item) => item.code === 'empty_cue_id'));
  assert.ok(unsupported.issues.some((item) => item.code === 'action_kind_not_allowed'));
  assert.ok(duplicateAction.issues.some((item) => item.code === 'duplicate_action_binding'));
  assert.throws(
    () => createSyncBindings(NARRATION, ACTIONS, [
      { ...CUES[0], actionIndex: ACTIONS.length },
    ]),
    (error) => error.code === 'bad_sync_bindings'
      && /отсутствующее действие/.test(error.message),
  );
});

test('речь не может вернуть экран к уже пройденному действию', () => {
  const source = bindingsFixture();
  const bindings = {
    ...source,
    cues: [
      { ...source.cues[2], from: 0, to: 5 },
      { ...source.cues[0], from: 36, to: 51 },
    ],
  };
  const result = validate(bindings);

  assert.equal(result.status, 'invalid');
  assert.ok(result.issues.some((item) => item.code === 'cue_order_conflict'));
});

test('patch сохраняет старую ручную связь, но не применяет её к изменённой фразе', () => {
  const bindings = bindingsFixture();
  const created = createScene({ scenes: [] }, {
    title: 'Три состояния',
    screenId: 'overview',
    narration: NARRATION,
    caption: '',
    subtitleText: '',
    startState: null,
    readyCondition: null,
    actions: ACTIONS,
    syncBindings: bindings,
  });
  const speechTiming = {
    id: 'speech-timing-1',
    inputHash: 'speech-input',
    contentHash: 'speech-content',
    producerVersion: 'speech-1',
    byteSize: 128,
  };
  const recordingTiming = {
    id: 'recording-timing-1',
    inputHash: 'recording-input',
    contentHash: 'recording-content',
    producerVersion: 'recording-1',
    byteSize: 256,
  };
  const measured = { ...created, speechTiming, recordingTiming };
  const changed = patchScene(measured, { narration: `${NARRATION} Готово.` });
  const reordered = patchScene(measured, {
    actions: [ACTIONS[1], ACTIONS[0], ACTIONS[2]],
  });

  assert.deepEqual(changed.syncBindings, bindings, 'ручная работа не удаляется');
  assert.deepEqual(changed.speechTiming, speechTiming);
  assert.deepEqual(changed.recordingTiming, recordingTiming);
  assert.equal(sceneSyncBindingsState(changed).status, 'stale');
  assert.deepEqual(
    sceneSyncBindingsState(reordered).issues.map((item) => item.code),
    ['actions_hash_mismatch'],
  );
  assert.deepEqual(reordered.syncBindings, bindings);
  assert.throws(
    () => patchScene(created, {
      narration: `${NARRATION} Готово.`,
      syncBindings: bindings,
    }),
    (error) => error.code === 'bad_sync_bindings' && /другой редакции текста/.test(error.message),
  );
  assert.equal(sceneSyncBindingsState(patchScene(changed, { syncBindings: null })).status, 'missing');
});
