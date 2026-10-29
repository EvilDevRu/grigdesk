import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArbiterConversationStore } from '../../server/src/lib/arbiterConversationStore.ts';
import { ArbiterConversationService } from '../../server/src/lib/arbiterConversationService.ts';
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
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-api-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const store = new ArbiterConversationStore(dir);
  let finish;
  let calls = 0;
  const prompts = [];
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const service = new ArbiterConversationService({
    store,
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

          if (calls === 1) {
            await held;
          }

          return { reply: `<arbiter-result>${JSON.stringify(result)}</arbiter-result>` };
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
