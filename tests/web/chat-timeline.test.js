import assert from 'node:assert/strict';
import test from 'node:test';
import { chatTimeline, createChatTimelineProjector, groupChatTimeline }
  from '../../web/src/views/chat/chatTimeline.ts';

const RUN = 'run-timeline';
const parent = {
  role: 'user',
  turnId: 'turn-timeline',
  text: 'Задача',
};
const reply = {
  role: 'assistant',
  kind: 'assistant-block',
  runId: RUN,
  assistantMessageId: 'answer-first',
  sequence: 1,
  text: 'Проверяю файл',
  complete: true,
};
const clarification = {
  role: 'user',
  kind: 'in-turn',
  runId: RUN,
  sequence: 2,
  messageId: 'question-one',
  text: 'А тесты?',
  receipt: { acceptedAt: 40 },
};
const answer = {
  ...reply,
  assistantMessageId: 'answer-second',
  sequence: 3,
  text: 'Запускаю тесты',
};
const steps = [
  {
    k: 'start',
    at: 10,
    model: 'test-model',
  },
  {
    k: 'tool',
    id: 'read-file',
    at: 20,
    title: 'Чтение файла',
  },
  {
    k: 'text',
    id: reply.assistantMessageId,
    at: 30,
    text: reply.text,
  },
  {
    k: 'think',
    at: 50,
    text: 'Проверка тестов',
  },
  {
    k: 'text',
    id: answer.assistantMessageId,
    at: 60,
    text: answer.text,
  },
  {
    k: 'tool',
    id: 'tests',
    at: 70,
    title: 'Тесты',
  },
];
const run = {
  runId: RUN,
  parentTurnId: parent.turnId,
  active: true,
  entries: [],
};

function labels(rows) {
  return rows.flatMap((row) => [
    ...row.steps.map((step) => step.title || step.text || step.k),
    ...(row.message.text ? [row.message.text] : []),
    ...(row.thinking ? ['Работает'] : []),
  ]);
}

test('старт, действия и реплики образуют одну хронологию активного хода', () => {
  const messages = [parent, reply, clarification, answer];
  const snapshot = JSON.stringify({
    messages,
    steps,
    run,
  });
  const rows = chatTimeline(messages, steps, true, run);

  assert.deepEqual(labels(rows), [
    'Задача', 'start', 'Чтение файла', 'Проверяю файл', 'А тесты?',
    'Проверка тестов', 'Запускаю тесты', 'Тесты', 'Работает',
  ]);
  assert.equal(rows.filter((row) => row.heading).length, 1);
  assert.equal(JSON.stringify({
    messages,
    steps,
    run,
  }), snapshot);
});

test('сохранённый ход сохраняет порядок и полный итог вне компактных реплик', () => {
  const final = {
    ...answer,
    assistantMessageId: 'answer-final',
    finalAssistantMessageId: 'answer-final',
    sequence: 4,
    text: 'Готово',
    steps,
    model: 'test-model',
  };
  const rows = chatTimeline([parent, reply, clarification, answer, final], [], false, null);

  assert.deepEqual(labels(rows), [
    'Задача', 'start', 'Чтение файла', 'Проверяю файл', 'А тесты?',
    'Проверка тестов', 'Запускаю тесты', 'Тесты', 'Готово',
  ]);
  assert.equal(rows.find((row) => row.message.text === 'Готово').compact, false);
  assert.equal(rows.find((row) => row.steps[0]?.k === 'start').live, true);
  assert.equal(rows.find((row) => row.steps[0]?.k === 'tool').live, false);
  assert.equal(rows.filter((row) => row.heading).length, 1);
});

test('дописанный черновик остаётся на прежнем месте и с тем же ключом', () => {
  const draft = {
    ...answer,
    startedAt: 60,
    complete: false,
  };
  const active = { ...run, entries: [draft] };
  const before = chatTimeline([parent, reply, clarification], steps, true, active);
  const after = chatTimeline([parent, reply, clarification, answer], steps, true, {
    ...active, entries: [{ ...draft, complete: true }],
  });

  assert.deepEqual(labels(before), labels(after));
  assert.deepEqual(before.map((row) => row.key), after.map((row) => row.key));
  assert.equal(after.filter((row) => row.message.text === answer.text).length, 1);
});

test('обновление инструмента и результат через реплику остаются при первом вызове', () => {
  const later = [
    ...steps,
    {
      k: 'tool',
      id: 'read-file',
      at: 80,
      title: 'Обновлённое чтение',
    },
    {
      k: 'res',
      id: 'read-file',
      at: 90,
      text: 'Прочитано',
    },
  ];
  const rows = chatTimeline([parent, reply, clarification, answer], later, true, run);
  const readRow = rows.find((row) => row.steps.some((step) => step.id === 'read-file'));

  assert.deepEqual(readRow.steps.map((step) => step.k), ['tool', 'tool', 'res']);
  assert.equal(rows.filter((row) => row.steps.some((step) => step.id === 'read-file')).length, 1);
});

test('блоки без времён из старой истории не поднимаются перед стартом', () => {
  const final = {
    role: 'assistant',
    runId: RUN,
    text: 'Готово',
    steps,
  };
  const missing = { ...reply, assistantMessageId: 'old-missing' };
  const rows = chatTimeline([parent, missing, answer, final], [], false, null);

  const text = labels(rows);

  assert.ok(text.indexOf('start') < text.indexOf(missing.text));
  assert.ok(text.indexOf(missing.text) < text.indexOf(answer.text));
  assert.equal(text.at(-1), 'Готово');
});

test('чужой ход с тем же id ответа и сообщение очереди не поглощаются текущим', () => {
  const earlier = {
    ...reply,
    runId: 'older-run',
    text: 'Прежний ответ',
  };
  const queued = {
    role: 'user',
    turnId: 'next-turn',
    queued: true,
    text: 'Следующая задача',
  };
  const rows = chatTimeline([earlier, parent, reply, queued], steps, true, run);

  assert.equal(labels(rows)[0], 'Прежний ответ');
  assert.equal(labels(rows).at(-1), 'Следующая задача');
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});

test('пустой живой ход встаёт после своего запроса, обычная история не меняется', () => {
  const older = {
    role: 'assistant',
    text: 'Раньше',
    steps: [{ k: 'start', at: 1 }],
  };
  const queued = {
    role: 'user',
    text: 'Следом',
    queued: true,
  };
  const rows = chatTimeline([older, parent, queued], steps.slice(0, 1), true, run);

  assert.deepEqual(labels(rows), ['start', 'Раньше', 'Задача', 'start', 'Работает', 'Следом']);
  assert.equal(rows[0].index, 0);
});

test('индикатор остаётся в конце текущего запуска до первого шага и после реплики', () => {
  const empty = chatTimeline([parent], [], true, run);

  assert.equal(empty.length, 2);
  assert.equal(empty[1].heading, true);
  assert.equal(empty[1].current, true);
  assert.equal(empty[1].thinking, true);

  const started = chatTimeline([parent, reply], [], true, run);

  assert.equal(started.at(-2).message.text, reply.text);
  assert.equal(started.at(-1).thinking, true);
  assert.equal(started.filter((row) => row.thinking).length, 1);
});

test('линия объединяет ход с уточнениями, но не захватывает очередь и соседний запуск', () => {
  const older = {
    role: 'assistant',
    runId: 'previous-run',
    model: 'previous-model',
    text: 'Старый итог',
  };
  const final = {
    role: 'assistant',
    runId: RUN,
    model: 'test-model',
    text: 'Новый итог',
    steps,
  };
  const queued = {
    role: 'user',
    turnId: 'next-turn',
    text: 'Следующий запрос',
    queued: true,
  };
  const groups = groupChatTimeline(chatTimeline(
    [older, parent, reply, clarification, answer, final, queued], [], false, null,
  ));
  const turns = groups.filter((group) => group.turn);

  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((group) => group.agent.model), ['previous-model', 'test-model']);
  assert.deepEqual(labels(turns[1].rows), [
    'start', 'Чтение файла', 'Проверяю файл', 'А тесты?', 'Проверка тестов',
    'Запускаю тесты', 'Тесты', 'Новый итог',
  ]);
  assert.equal(groups.at(-1).turn, false);
  assert.equal(groups.at(-1).rows[0].message.text, queued.text);
});

test('активный шаг переиспользует исторические участки, а индексы и объекты обновляются', () => {
  const projector = createChatTimelineProjector();
  const final = {
    ...answer,
    steps,
    model: 'old-model',
    actualModel: 'old-actual',
    effort: 'low'
  };
  const history = [parent, reply, clarification, final];
  const active = { ...run, runId: 'new-run' };
  const before = projector.project(history, [], true, active);
  const replacement = {
    ...final,
    attachments: [{
    file: 'new-file'
  }],
    cost: 0.2
  };
  const after = projector.project([{ role: 'user', text: 'Вставка' },
    parent, reply, clarification, replacement], [{ k: 'think', text: 'Новый шаг' }], true, active);
  const oldSections = before.filter((row) => row.turnKey === RUN && row.steps.length);
  const newSections = after.filter((row) => row.turnKey === RUN && row.steps.length);

  assert.ok(oldSections.length > 0);
  assert.equal(oldSections.every((row, index) => row.steps === newSections[index].steps), true);
  assert.equal(after.find((row) => row.message === replacement).index, 4);
  assert.equal(after.find((row) => row.message === replacement).message.cost, 0.2);
  assert.equal(after.find((row) => row.message === clarification).index, 3);
});

test('снимок скаляров ловит правку receipt и финала на месте, новый массив и длину steps', () => {
  const projector = createChatTimelineProjector();
  const middle = { ...clarification, receipt: { acceptedAt: 40 } };
  const final = {
    ...answer,
    steps: [...steps],
    model: 'old',
    effort: 'low'
  };
  const history = [parent, reply, middle, final];
  const project = () => projector.project(history, [], false, null);
  let before = project();

  project();
  project();
  middle.receipt.acceptedAt = 65;

  const moved = project();

  assert.notEqual(labels(before).join('|'), labels(moved).join('|'));
  before = moved;
  final.actualModel = 'actual';
  final.effort = 'high';

  const metadata = project();

  assert.equal(metadata.find((row) => row.steps.length).message.actualModel, 'actual');
  assert.equal(metadata.find((row) => row.steps.length).message.effort, 'high');

  const oldSteps = before.find((row) => row.steps.length).steps;
  const metadataSteps = metadata.find((row) => row.steps.length).steps;

  assert.equal(oldSteps === metadataSteps, false);
  final.steps = [...final.steps];

  const replaced = project();

  const replacedSteps = replaced.find((row) => row.steps.length).steps;

  assert.equal(metadataSteps === replacedSteps, false);
  final.steps.push({ k: 'note', text: 'Дополнение' });
  assert.ok(labels(project()).includes('Дополнение'));
  projector.clear();
  assert.deepEqual(labels(project()), labels(chatTimeline(history, [], false, null)));
});

test('попадания в кэш не теряют реактивную подписку на вложенный receipt', async () => {
  const { computed, reactive } = await import('../../web/node_modules/vue/index.mjs');
  const middle = reactive({ ...clarification, receipt: { acceptedAt: 40 } });
  const history = reactive([parent, reply, middle, { ...answer, steps }]);
  const activeSteps = reactive([]);
  const projector = createChatTimelineProjector();
  const timeline = computed(() => projector.project(history, activeSteps, true, {
    ...run, runId: 'current-other',
  }));

  void timeline.value;

  for (let index = 0; index < 3; index += 1) {
    activeSteps.push({ k: 'note', text: 'Живой шаг' });
    void timeline.value;
  }

  const before = labels(timeline.value).join('|');

  middle.receipt.acceptedAt = 65;
  assert.notEqual(labels(timeline.value).join('|'), before);
});
