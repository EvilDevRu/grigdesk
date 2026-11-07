// Проверяет разбор расшифровки встречи в безопасные черновики задач.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEETING_PLAN_LIMITS,
  buildMeetingPlanPrompt,
  meetingTaskDraft,
  meetingTranscript,
  parseMeetingPlan,
  runMeetingPlan,
  timecode,
} from '../../server/src/lib/media/meetingPlan.ts';

const SEGMENTS = [
  { start: 0, end: 4, text: 'Привет, все на месте?' },
  { start: 271.5, end: 275, text: 'Нужно добавить в комментарии время, до какого забрать.' },
  { start: 640, end: 644, text: 'И вторым номером указывать приоритет.' },
];

const planReply = (tasks) => JSON.stringify({ tasks });
const task = (over = {}) => ({
  segments: [2],
  title: 'Комментарий со временем забора',
  description: 'Добавить в комментарий время, до которого нужно забрать.',
  confidence: 0.8,
  reason: 'Прозвучало прямой просьбой.',
  ...over,
});

test('транскрипт нумеруется с таймкодами и честно сообщает об обрезке', () => {
  const full = meetingTranscript(SEGMENTS);
  assert.equal(full.count, 3);
  assert.equal(full.truncated, false);
  assert.match(full.transcript, /^#1 \[00:00\] Привет/u);
  assert.match(full.transcript, /#2 \[04:31\] Нужно добавить/u);
  assert.equal(timecode(640), '10:40');

  // Обрезка обязана быть видимой: модель не читала хвост и не имеет права
  // приписывать ему задачи, а человек должен знать, что разобрал не всё.
  const cut = meetingTranscript(SEGMENTS, { limit: 40 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.count < 3);
  assert.equal(cut.total, 3);

  // Пустая реплика номер не занимает: иначе нумерация в промпте разошлась бы
  // с той, по которой потом ищется таймкод.
  assert.equal(meetingTranscript([{ start: 1, text: '  ' }, { start: 2, text: 'есть' }]).count, 1);
});

test('план принимает непокрытые и пересекающиеся реплики, но не выдуманные номера', () => {
  const { count } = buildMeetingPlanPrompt(SEGMENTS);
  assert.equal(count, 3);

  // Непокрытые реплики — норма: большая часть встречи задачами не является.
  const single = parseMeetingPlan(planReply([task()]), { count });
  assert.equal(single.length, 1);
  assert.deepEqual(single[0].segments, [2]);

  // Пересечение здесь законно (в отличие от Inbox): durable-решения нет, это черновики,
  // и одна реплика про сроки честно относится к обеим задачам.
  const crossed = parseMeetingPlan(
    planReply([task({ segments: [2, 3] }), task({ segments: [3] })]),
    { count },
  );
  assert.equal(crossed.length, 2);

  // Номер вне диапазона проверить нечем и таймкод для него взять неоткуда.
  assert.equal(parseMeetingPlan(planReply([task({ segments: [9] })]), { count }), null);
  assert.equal(parseMeetingPlan(planReply([task({ segments: [] })]), { count }), null);
  // Лишнее поле — ответ не по контракту, а не «модель добавила полезное».
  assert.equal(parseMeetingPlan(planReply([{ ...task(), extra: 1 }]), { count }), null);
  assert.equal(parseMeetingPlan('не json', { count }), null);
  assert.equal(
    parseMeetingPlan(planReply([task({ title: 'я'.repeat(MEETING_PLAN_LIMITS.title + 1) })]), { count }),
    null,
  );

  // Пустой план — законный ответ «задач не прозвучало», он отличается от отказа.
  assert.deepEqual(parseMeetingPlan(planReply([]), { count }), []);
  // Забор markdown вокруг ответа встречается у любой модели и разбору не мешает.
  assert.equal(parseMeetingPlan(`\`\`\`json\n${planReply([task()])}\n\`\`\``, { count }).length, 1);
});

test('черновик несёт таймкод места на записи', () => {
  const draft = meetingTaskDraft(
    { ...task(), segments: [2, 3] },
    SEGMENTS,
  );
  assert.match(draft.description, /На записи: 04:31, 10:40/u);
  assert.equal(draft.title, 'Комментарий со временем забора');
  assert.equal(draft.confidence, 0.8);
});

test('runMeetingPlan идёт только через недоверенный transport и называет отказ кодом', async () => {
  const calls = [];
  const executor = {
    runUntrusted(value) {
      calls.push(value);
      return { reply: planReply([task()]) };
    },
    // Обычный coding run существует, но использоваться не должен: расшифровка —
    // чужая речь, и tools/workspace ей не полагаются.
    run() { throw new Error('обычный run для расшифровки запрещён'); },
  };
  const ok = await runMeetingPlan({
    segments: SEGMENTS,
    modelRef: { provider: 'claude', model: 'claude-opus-5' },
    hint: 'нас интересует только логистика',
    resolveTarget: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'claude-opus-5' },
      executor,
    }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.tasks.length, 1);
  assert.equal(ok.model, 'claude/claude-opus-5');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images, []);
  assert.match(calls[0].message, /нас интересует только логистика/u);
  assert.match(calls[0].message, /#2 \[04:31\]/u);

  const noModel = await runMeetingPlan({
    segments: SEGMENTS,
    resolveTarget: async () => ({ ok: false, error: 'no_model' }),
  });
  assert.deepEqual(noModel, { ok: false, error: 'no_model' });

  const empty = await runMeetingPlan({ segments: [], resolveTarget: async () => { throw new Error('не звать'); } });
  assert.deepEqual(empty, { ok: false, error: 'empty_transcript' });

  const broken = await runMeetingPlan({
    segments: SEGMENTS,
    resolveTarget: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'm' },
      executor: { runUntrusted: () => ({ reply: '{"tasks": [{"segments": [42]}]}' }) },
    }),
  });
  assert.deepEqual(broken, { ok: false, error: 'bad_plan' });

  const failed = await runMeetingPlan({
    segments: SEGMENTS,
    resolveTarget: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'm' },
      executor: { runUntrusted: () => { throw new Error('сеть'); } },
    }),
  });
  assert.deepEqual(failed, { ok: false, error: 'run_failed' });
});

test('плагин «Видео» объявляет свою модель разбора, а не заимствует чужую', async () => {
  const { SYSTEM } = await import('../../server/src/lib/pluginsRegistry.ts');
  const video = SYSTEM.find((plugin) => plugin.id === 'video');
  const setting = video.settings.find((item) => item.key === 'triageModel');
  assert.equal(setting.type, 'model');
  assert.equal(setting.default, null);
  // Настройка Inbox принадлежит Inbox: молчаливый fallback связал бы два раздела
  // скрытой зависимостью, и смена модели во «Входящих» меняла бы разбор встреч.
  const inbox = SYSTEM.find((plugin) => plugin.id === 'inbox');
  assert.notEqual(inbox.settings.find((item) => item.key === 'triageModel').hint, setting.hint);
});

test('усилие доезжает до недоверенного запуска, а не теряется по дороге', async () => {
  // До этого раздел всегда шёл на умолчании исполнителя, и выбрать уровень было нечем.
  const calls = [];
  const result = await runMeetingPlan({
    segments: SEGMENTS,
    resolveTarget: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'm' },
      effort: 'xhigh',
      executor: {
        runUntrusted: (options) => {
          calls.push(options.effort);
          return { reply: '{"tasks": []}' };
        },
      },
    }),
  });
  assert.deepEqual(calls, ['xhigh']);
  assert.equal(result.effort, 'xhigh', 'фактический уровень обязан вернуться наружу');

  // Уровня нет — поле не подставляется вовсе: пустая строка у claude станет
  // `--effort ""` и уронит запуск CLI, а не будет прочитана как «умолчание».
  const bare = [];
  const plain = await runMeetingPlan({
    segments: SEGMENTS,
    resolveTarget: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'm' },
      effort: null,
      executor: {
        runUntrusted: (options) => {
          bare.push('effort' in options ? options.effort : '<нет ключа>');
          return { reply: '{"tasks": []}' };
        },
      },
    }),
  });
  assert.deepEqual(bare, [undefined]);
  assert.equal(plain.effort, null);
});

test('резолвер снимает уровень, которого у модели нет, а не роняет разбор', async () => {
  // `--effort xhigh` у модели без такой возможности не игнорируется, а валит запуск CLI.
  // Настройка живёт долго и легко устаревает после обновления бинаря, поэтому уровень
  // сверяется с реестром перед каждым ходом.
  const { resolveInboxTriageTarget } = await import('../../server/src/lib/inbox/triage.ts');
  const executor = { runUntrusted() {}, untrustedInput: { text: true } };
  const registry = async () => ({
    claude: [{ id: 'm', name: 'M', efforts: ['low', 'high'], inputModalities: ['text'] }],
  });
  const warns = [];
  const log = { warn: (data) => warns.push(data) };

  const kept = await resolveInboxTriageTarget({
    modelRef: { provider: 'claude', model: 'm', effort: 'high' },
    modelsRegistry: registry,
    executorResolver: async () => executor,
    log,
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.effort, 'high');
  assert.equal(warns.length, 0);

  const dropped = await resolveInboxTriageTarget({
    modelRef: { provider: 'claude', model: 'm', effort: 'xhigh' },
    modelsRegistry: registry,
    executorResolver: async () => executor,
    log,
  });
  assert.equal(dropped.ok, true, 'устаревший уровень не отменяет разбор — он снимается');
  assert.equal(dropped.effort, null);
  assert.equal(warns.length, 1, 'снятие уровня обязано попасть в журнал, а не пройти немо');
});
