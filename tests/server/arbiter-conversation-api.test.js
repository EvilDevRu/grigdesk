import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArbiterConversationStore } from '../../server/src/lib/arbiterConversationStore.ts';
import { ArbiterConversationService } from '../../server/src/lib/arbiterConversationService.ts';
import { FactoryArbiterLive } from '../../server/src/lib/factoryArbiterLive.ts';
import {
  registerArbiterConversationRoutes
} from '../../server/src/modules/factory/arbiterConversationRoutes.ts';

const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');
const identity = {
  task: '7',
  profile: 'demo',
  attempt: `a_${'a'.repeat(32)}`,
  node: 'verify',
  stop: 'human',
  stageSequence: 2,
  stageHeadHash: 'b'.repeat(64)
};
const result = {
  summary: 'Нужно уточнить причину остановки.',
  questions: [
    {
      id: 'q',
      text: 'Есть журнал?',
      options: [{ id: 'yes', label: 'Да, журнал есть' }],
      allowCustom: true
    },
  ],
  proposals: [{
    id: 'd',
    kind: 'diagnose',
    label: 'Изучить журнал',
    explanation: 'Прочитаю данные.',
    expectedResult: 'Сведения о причине.',
    recommended: true,
    diagnosticInstruction: 'Прочитай журнал.'
  }],
  technicalDetails: ''
};

/**
 * HTTP работает с настоящим durable service и удерживаемым executor без живых задач.
 * Внешняя команда отсутствует в зависимостях читающего хода.
 */
async function fixture(t, { replies = [], holdAll = false, afterAbort = async () => {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-api-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const store = new ArbiterConversationStore(dir);
  let finish;
  let calls = 0;
  const prompts = [];
  const inputs = [];
  const live = new FactoryArbiterLive();
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const service = new ArbiterConversationService({
    store,
    live,
    readContext: async () => ({
      identity,
      targets: [],
      sourceText: 'Лимит проверки.',
      evidence: {},
      sourceLabel: 'Сообщение проверки',
      policies: [],
      reportPath: null
    }),
    capabilities: async () => ({
      status: 'unsupported',
      message: 'Старый движок',
      targets: []
    }),
    prepareRun: async () => ({
      input: {}, executor: {
        run: async (input) => {
          calls += 1;
          prompts.push(input.message);
          inputs.push(input);

          if (calls === 1 || holdAll) {
            try {
              await Promise.race([
                held,
                new Promise((_resolve, reject) => {
                  input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
                }),
              ]);
            } finally {
              if (input.signal.aborted) {
                await afterAbort();
              }
            }
          }

          const reply = JSON.stringify(replies[calls - 1] || result);

          return { reply: `<arbiter-result>${reply}</arbiter-result>` };
        }
      }
    }),
  });
  const app = Fastify();

  registerArbiterConversationRoutes(app, service, { stateDir: dir });
  await app.ready();
  t.after(() => service.close());
  t.after(() => app.close());

  return {
    app,
    service,
    store,
    finish,
    prompts,
    inputs,
    live,
    dir,
    calls: () => calls
  };
}

test('GET без создания; POST даёт durable 202 до завершения модели и отвергает лишние поля', async (t) => {
  const fx = await fixture(t);
  const url = '/api/tasks/7/arbiter-conversations';
  const current = await fx.app.inject({ url: `${url}/current` });

  assert.equal(current.statusCode, 200);
  assert.equal((await fx.store.list()).length, 0);
  assert.equal(fx.calls(), 0);

  const invalid = await fx.app.inject({
    method: 'POST',
    url,
    payload: {
      requestId: randomUUID(),
      expectedStop: identity,
      shell: 'echo bad'
    }
  });

  assert.equal(invalid.statusCode, 400);

  const payload = { requestId: randomUUID(), expectedStop: identity };
  const started = await fx.app.inject({
    method: 'POST',
    url,
    payload
  });

  assert.equal(started.statusCode, 202);

  const ack = started.json();

  assert.equal((await fx.store.read('7', ack.conversationId)).operations[0].id, ack.operationId);

  const repeat = await fx.app.inject({
    method: 'POST',
    url,
    payload
  });

  assert.equal(repeat.json().operationId, ack.operationId);

  const conflict = await fx.app.inject({
    method: 'POST',
    url,
    payload: { ...payload, expectedStop: { ...identity, stageSequence: 3 } }
  });

  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'request_conflict');
  fx.finish();
  await fx.service.wait('7');
  assert.equal(fx.calls(), 1);
});

test('остановка прерывает exact ход, сохраняет реплики и не принимает поздний ответ', async (t) => {
  const fx = await fixture(t);
  const started = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity }, true);

  await new Promise((resolve) => setImmediate(resolve));
  fx.inputs[0].onAssistantMessage({
    assistantMessageId: 'partial',
    text: '<arbiter-message>Уже прочитал журнал',
    sourceRevision: 1,
    complete: false,
  });

  const url = '/api/tasks/7/arbiter-conversations/stop';
  const invalid = await fx.app.inject({
    method: 'POST',
    url,
    payload: {},
  });

  assert.equal(invalid.statusCode, 400);
  assert.equal(fx.inputs[0].signal.aborted, false);

  const response = await fx.app.inject({
    method: 'POST',
    url,
    payload: { operationId: started.operationId },
  });
  const saved = await fx.store.read('7', started.conversationId);

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().outcome, 'stopped');
  assert.equal(fx.inputs[0].signal.aborted, true);
  assert.equal(fx.live.read('7'), null);
  assert.equal(saved.state, 'interrupted');
  assert.equal(saved.result, null);
  assert.equal(saved.operations[0].error, 'cancelled');
  assert.match(saved.operations[0].message, /остановлен человеком/);
  assert.equal(saved.messages.find((row) => row.text === 'Уже прочитал журнал')?.status, 'interrupted');

  const repeated = await fx.app.inject({
    method: 'POST',
    url,
    payload: { operationId: started.operationId },
  });

  assert.equal(repeated.json().outcome, 'not_running');
  fx.inputs[0].onAssistantMessage({
    assistantMessageId: 'partial',
    text: '<arbiter-message>Запоздалый ответ</arbiter-message>',
    sourceRevision: 2,
    complete: true,
  });
  fx.finish();
  await started.completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fx.store.read('7', started.conversationId)).revision, saved.revision);

  await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity }, true);
  assert.equal(fx.calls(), 1, 'авторазбор не повторяет остановленный ход');
});

test('запоздалая остановка старого хода не отменяет новый разбор', async (t) => {
  const fx = await fixture(t, { holdAll: true });
  const first = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });

  await fx.service.stopRead('7', first.operationId);

  const second = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });
  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/arbiter-conversations/stop',
    payload: { operationId: first.operationId },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'stale_operation');
  assert.equal(fx.inputs.at(-1).signal.aborted, false);
  assert.equal(fx.live.read('7').runId, second.operationId);
  await fx.service.stopRead('7', second.operationId);
});

test('продолжение ждёт освобождения исполнителя после сигнала отмены', async (t) => {
  let entered;
  let release;
  let launched = false;
  const cleaning = new Promise((resolve) => {
    entered = resolve;
  });
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  const fx = await fixture(t, {
    afterAbort: async () => {
      entered();
      await cleanup;
    },
  });

  t.after(() => release());
  await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });

  const continuation = fx.service.withReadStopped('7', async () => {
    launched = true;
  });

  await cleaning;
  assert.equal(launched, false);
  release();
  await continuation;
  assert.equal(launched, true);
});

test('продолжение ждёт сохранения остановки и блокирует новый разбор до завершения запуска', async (t) => {
  const fx = await fixture(t);
  const started = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });
  let entered;
  let release;
  const launching = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const resume = fx.service.withReadStopped('7', async () => {
    const saved = await fx.store.read('7', started.conversationId);

    assert.equal(saved.state, 'interrupted');
    assert.match(saved.operations[0].message, /перед продолжением прогона/);
    assert.equal(fx.live.read('7'), null);
    entered();
    await held;

    return 'launched';
  });

  await launching;

  const next = fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.calls(), 1, 'новая модель не стартует во время продолжения');
  release();
  assert.equal(await resume, 'launched');

  const ack = await next;

  await ack.completion;
  assert.equal(fx.calls(), 2);
});

test('перезапуск завершает чтение как interrupted и не повторяет модель; auto не повторяет exact stop',
  async (t) => {
    const fx = await fixture(t);
    const started = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity }, true);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fx.calls(), 1);

    const recovered = new ArbiterConversationService({ store: fx.store });

    await recovered.recover();

    const doc = await fx.store.read('7', started.conversationId);

    assert.equal(doc.state, 'interrupted');
    assert.equal(doc.operations[0].error, 'interrupted');
    assert.equal(fx.calls(), 1);
    fx.finish();
    await started.completion;
    assert.equal((await fx.store.read('7', doc.id)).state, 'interrupted');

    const repeated = await fx.service.start('7', {
      requestId: randomUUID(), expectedStop: identity,
    }, true);

    assert.equal(repeated.operationId, started.operationId);
    assert.equal(fx.calls(), 1);
  });

test('журнал привязан к задаче и диалогу; ссылка вместо файла не выдаётся', async (t) => {
  const fx = await fixture(t);
  const started = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });

  fx.finish();
  await started.completion;
  await fs.mkdir(path.join(fx.dir, 'logs'));

  const file = path.join(fx.dir, 'logs/t7.stages.log');
  const url = `/api/tasks/7/arbiter-conversations/${started.conversationId}/journal`;

  await fs.writeFile(file, 'Полный журнал всех визитов.');

  const response = await fx.app.inject({ url });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'Полный журнал всех визитов.');
  assert.equal((await fx.app.inject({ url: url.replace('/7/', '/8/') })).statusCode, 404);
  await fs.rm(file);
  await fs.symlink(path.join(fx.dir, '7', `${started.conversationId}.json`), file);
  assert.equal((await fx.app.inject({ url })).statusCode, 404);
});

test('обсуждение и вариант вопроса доходят до runner; старые варианты закрыты сразу', async (t) => {
  const fx = await fixture(t);
  const started = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });

  fx.finish();
  await started.completion;

  const doc = await fx.store.read('7', started.conversationId);
  const message = await fx.app.inject({
    method: 'POST',
    url: `/api/tasks/7/arbiter-conversations/${doc.id}/messages`,
    payload: {
      requestId: randomUUID(),
      expectedStop: identity,
      decisionRevision: doc.decisionRevision,
      questionId: 'q',
      optionId: 'yes',
    }
  });

  assert.equal(message.statusCode, 202);
  await fx.service.wait('7');
  assert.match(fx.prompts[1], /Да, журнал есть/);

  const answered = await fx.store.read('7', doc.id);

  assert.deepEqual(answered.operations[1].answeredQuestion, {
    questionId: 'q',
    optionId: 'yes',
    question: 'Есть журнал?',
    answer: 'Да, журнал есть',
  });
  assert.deepEqual(answered.result.questions, []);
  assert.equal(answered.result.nextStep, 'choose_proposal');

  const stale = await fx.app.inject({
    method: 'POST',
    url: `/api/tasks/7/arbiter-conversations/${doc.id}/diagnose`,
    payload: {
      requestId: randomUUID(),
      expectedStop: identity,
      decisionRevision: doc.decisionRevision,
      proposalId: 'd',
    }
  });

  assert.equal(stale.statusCode, 409);
});

test('ответы закрывают вопросы, сохраняют выбор диагностики и допускают окончание уточнений', async (t) => {
  const question = {
    id: 'q1',
    text: 'Когда принять решение об изменении проверки?',
    options: [{ id: 'defer', label: 'Решить после следующего адресного плана' }],
    allowCustom: true,
  };
  const second = { ...result.questions[0], id: 'q2' };
  const replies = [
    { ...result, questions: [question, second] },
    {
      ...result,
      summary: 'Решение отложено до нового плана. Осталось уточнить наличие журнала.',
      questions: [second],
    },
    {
      ...result,
      summary: 'Журнал доступен. Выберите его дополнительный разбор.',
      questions: [],
      nextStep: 'choose_proposal',
    },
    {
      ...result,
      summary: 'Решение учтено. Вернёмся к обсуждению после подготовки плана.',
      questions: [],
      proposals: [],
      nextStep: 'continue_discussion',
    },
  ];
  const fx = await fixture(t, { replies });
  const start = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });

  fx.finish();
  await start.completion;

  for (const [index, payload] of [
    { questionId: 'q1', optionId: 'defer' },
    { questionId: 'q2', customAnswer: 'Журнал есть.\n\nОн полный.' },
    { text: 'Вернёмся после плана.' },
  ].entries()) {
    const before = await fx.store.read('7', start.conversationId);
    const ack = await fx.service.submit('7', before.id, 'discuss', {
      requestId: randomUUID(),
      expectedStop: identity,
      decisionRevision: before.decisionRevision,
      ...payload,
    });

    await ack.completion;

    const saved = await fx.store.read('7', before.id);
    const contents = JSON.parse(fx.prompts[index + 1].split('\n\n').at(-1));

    assert.equal(saved.state, 'awaiting_user');
    assert.equal(saved.result.summary, replies[index + 1].summary);
    assert.deepEqual(saved.result.questions, replies[index + 1].questions);
    assert.deepEqual(saved.result.proposals, replies[index + 1].proposals);
    assert.equal(contents.answeredQuestions[0].question, question.text);
    assert.equal(contents.answeredQuestions[0].answer, question.options[0].label);

    if (index > 0) {
      assert.equal(contents.answeredQuestions[1].answer, 'Журнал есть.\n\nОн полный.');
    }
  }

  assert.equal(fx.calls(), 4);
});

test('GET между durable записью и регистрацией job не прерывает принимаемый разбор', async (t) => {
  const fx = await fixture(t);
  const update = fx.store.update.bind(fx.store);
  let observed = null;
  let checked = false;

  t.mock.method(fx.store, 'update', async (...args) => {
    const doc = await update(...args);

    if (doc.state === 'analyzing' && !checked) {
      checked = true;
      observed = await fx.service.snapshot('7', doc.id);
    }

    return doc;
  });

  const started = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity });

  assert.equal(observed.state, 'analyzing');
  assert.equal(observed.operations[0].outcome, 'running');
  fx.finish();
  await started.completion;
  assert.equal((await fx.store.read('7', started.conversationId)).state, 'awaiting_user');
});

test('shutdown во время подготовки не принимает новый job после закрытия сервиса', async (t) => {
  const fx = await fixture(t);
  let release;
  let entered;
  const preparing = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const service = new ArbiterConversationService({
    store: fx.store,
    readContext: async () => ({ identity, targets: [] }),
    capabilities: async () => ({
      status: 'unknown',
      message: '',
      targets: []
    }),
    prepareRun: async () => {
      entered();
      await held;

      return { input: {}, executor: { run: async () => assert.fail('Новый executor после shutdown') } };
    },
  });
  const starting = service.start('7', { requestId: randomUUID(), expectedStop: identity });
  const rejected = assert.rejects(starting, { code: 'server_restarting' });

  await preparing;
  await service.close();
  release();
  await rejected;
  assert.equal((await fx.store.list('7'))[0].operations.length, 0);
});

test('auto на ранее созданном idle диалоге сохраняет уведомление и не повторяет exact stop', async (t) => {
  const fx = await fixture(t);
  const idle = await fx.store.create(identity, {
    status: 'unknown',
    message: '',
    targets: []
  });
  const started = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity }, true);

  fx.finish();
  await started.completion;

  const doc = await fx.store.read('7', idle.id);
  const again = await fx.service.start('7', { requestId: randomUUID(), expectedStop: identity }, true);

  assert.equal(started.conversationId, idle.id);
  assert.equal(doc.automatic, true);
  assert.equal(again.operationId, started.operationId);
  assert.equal(fx.calls(), 1);
});

test('startup оставляет незавершённый resume неизвестным и не запускает его автоматически', async (t) => {
  const fx = await fixture(t);
  const doc = await fx.store.create(identity, {
    status: 'unknown',
    message: '',
    targets: []
  });

  await fx.store.update('7', doc.id, (current) => {
    current.state = 'resolved';
    current.operations.push({
      id: 'resume-before-crash',
      requestId: randomUUID(),
      fingerprint: 'a'.repeat(64),
      kind: 'resume',
      outcome: 'running',
      createdAt: current.createdAt,
      updatedAt: current.createdAt,
    });
  });

  const recovered = new ArbiterConversationService({ store: fx.store });

  await recovered.recover();

  const saved = await fx.store.read('7', doc.id);

  assert.equal(saved.state, 'resolved');
  assert.equal(saved.operations[0].outcome, 'unknown');
  assert.equal(saved.operations[0].error, 'interrupted');
  assert.equal(fx.calls(), 0);
});

test('shutdown после durable apply не вызывает goto и оставляет доступный прерванный диалог', async (t) => {
  const fx = await fixture(t);
  const targets = [{
    node: 'verify',
    label: 'Проверка',
    executorKind: 'agent',
    acceptsInstruction: true,
    canRetryUnchanged: false,
    resetNodes: ['verify'],
  }];
  const capabilities = {
    status: 'supported',
    message: '',
    targets
  };
  const doc = await fx.store.create(identity, capabilities);
  let calls = 0;
  const service = new ArbiterConversationService({
    store: fx.store,
    readContext: async () => ({ identity, targets }),
    capabilities: async () => capabilities,
    apply: async () => {
      calls += 1;
    },
  });
  const update = fx.store.update.bind(fx.store);

  t.mock.method(fx.store, 'update', async (...args) => {
    const current = await update(...args);

    if (current.state === 'applying') {
      await service.close();
    }

    return current;
  });

  const ack = await service.submit('7', doc.id, 'apply', {
    requestId: randomUUID(),
    expectedStop: identity,
    decisionRevision: 0,
    customAction: {
      kind: 'replay_current',
      targetNode: 'verify',
      instruction: 'Проверь заново.'
    },
  });

  await ack.completion;

  const saved = await fx.store.read('7', doc.id);

  assert.equal(calls, 0);
  assert.equal(saved.state, 'interrupted');
  assert.equal(saved.operations[0].outcome, 'failed');
  assert.equal(saved.operations[0].error, 'server_restarting');
});
