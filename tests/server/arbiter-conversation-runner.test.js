import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArbiterConversationStore } from '../../server/src/lib/arbiterConversationStore.ts';
import { resolveArbiterTarget } from '../../server/src/lib/factoryArbiter.ts';
import { resolveModelRef } from '../../server/src/lib/chat/modelRef.ts';
import { createGlmFakeRuntime } from '../helpers/glmFakeRuntime.mts';
import {
  projectArbiterFrames,
  runArbiterConversation
} from '../../server/src/lib/arbiterConversationRunner.ts';

const result = {
  summary: 'Проверка не завершилась; причина ещё неизвестна.',
  questions: [
    {
      id: 'q',
      text: 'Уточните время остановки.',
      options: [],
      allowCustom: true
    },
  ],
  proposals: [],
  technicalDetails: 'Техническое доказательство'
};
const framedResult = `<arbiter-result>${JSON.stringify(result)}</arbiter-result>`;

test('projector удерживает разрезанные маркеры и скрывает неразмеченный текст и JSON', () => {
  assert.deepEqual(projectArbiterFrames('PRIVATE <arbiter-message>Вижу остановку.</arbiter-mes').messages,
    [{ text: 'Вижу остановку.', complete: false }]);

  const text = '<arbiter-message>Проверяю <arbiter-message>журнал</arbiter-message>скрытый хвост'
    + framedResult;

  assert.deepEqual(projectArbiterFrames(text).messages, [{ text: 'Проверяю журнал', complete: true }]);
  assert.deepEqual(projectArbiterFrames('<arbiter-message>Текст<arbiter-mes').messages,
    [{ text: 'Текст', complete: false }]);
  assert.equal(projectArbiterFrames(framedResult.slice(0, -2)).resultComplete, false);
  assert.deepEqual(projectArbiterFrames(framedResult).messages, []);
});

test('ошибочный result внутри публичного кадра не раскрывает JSON ни на одном разрезе', () => {
  const text = '<arbiter-message>Проверяю. <arbiter-result>{"private":"SECRET"}</arbiter-result>'
    + 'скрытый хвост</arbiter-message>' + framedResult;

  for (let end = 1; end <= text.length; end += 1) {
    const frames = projectArbiterFrames(text.slice(0, end));

    const exposed = frames.messages.some((message) => /SECRET|arbiter-result|private/.test(message.text));

    assert.equal(exposed, false);
  }

  assert.equal(projectArbiterFrames(text).messages[0].text, 'Проверяю.');
  assert.equal(projectArbiterFrames(text).resultText, JSON.stringify(result));
});

test('публичные кадры убирают пустые края и опечатку закрывающего тега GLM', () => {
  const text = '<arbiter-message>\n\nПричина найдена.\n</arbriter-message>SECRET'
    + framedResult;

  for (let end = 1; end <= text.length; end += 1) {
    const frames = projectArbiterFrames(text.slice(0, end));

    assert.equal(frames.messages.some((row) => /<|arbriter-message|summary|SECRET/u.test(row.text)), false);
  }

  assert.deepEqual(projectArbiterFrames(text).messages, [{ text: 'Причина найдена.', complete: true }]);
  assert.equal(projectArbiterFrames(text).resultText, JSON.stringify(result));
});

test('уже отменённый ход не вызывает executor и сохраняет interrupted', async (t) => {
  const fx = await fixture(t);
  const controller = new AbortController();
  let calls = 0;

  controller.abort(new Error('Сервер завершает работу.'));
  await runArbiterConversation({
    ...fx,
    operationId: 'turn',
    input: {},
    controller,
    executor: {
      run: async () => {
        calls += 1;
      }
    },
    readCurrent: async () => fx.context,
  });
  assert.equal(calls, 0);
  assert.equal((await fx.store.read('7', fx.doc.id)).state, 'interrupted');
});

/**
 * Fake executor не завершается, пока проверка не отпустит его явно.
 * Это доказывает видимость durable сообщения до конечного ответа модели.
 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-runner-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const store = new ArbiterConversationStore(dir);
  const identity = {
    task: '7',
    profile: 'demo',
    attempt: `a_${'a'.repeat(32)}`,
    node: 'verify',
    stop: 'human',
    stageSequence: 2,
    stageHeadHash: 'b'.repeat(64)
  };
  const doc = await store.create(identity, {
    status: 'supported',
    message: '',
    targets: []
  });

  await store.update('7', doc.id, (current) => {
    current.state = 'analyzing';
    current.operations.push({
      id: 'turn',
      requestId: 'request',
      fingerprint: 'a'.repeat(64),
      kind: 'start',
      outcome: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });

  return {
    store,
    doc,
    context: {
      identity,
      targets: [],
      sourceText: 'Проверка превысила лимит.',
      evidence: {},
      sourceLabel: 'Сообщение проверки',
      policies: [],
      reportPath: null
    }
  };
}

test('проверенный auto доходит до исполнителя и разбор сохраняет результат', async (t) => {
  const fx = await fixture(t);
  const modes = [];
  const target = await resolveArbiterTarget({
    modelRef: { provider: 'test', model: 'arbiter' },
    modelsRegistry: async () => ({ test: [{ id: 'arbiter' }] }),
    resolveRef: resolveModelRef,
    executorResolver: async () => ({
      modes: () => [{ id: 'auto' }],
      run: async (input) => {
        assert.equal(input.chatKey, `arbiter:${fx.doc.id}:turn`);
        assert.equal(input.sessionId, null);
        await input.onSessionCreated('service-session');
        modes.push(input.permissionMode);

        return { reply: framedResult };
      },
    }),
  });

  assert.equal(target.ok, true);

  await runArbiterConversation({
    ...fx,
    operationId: 'turn',
    input: { permissionMode: target.permissionMode },
    executor: target.executor,
    readCurrent: async () => fx.context,
  });

  assert.deepEqual(modes, ['auto']);
  assert.equal((await fx.store.read('7', fx.doc.id)).state, 'awaiting_user');
});

test('GLM выполняет разбор в auto через настоящий адаптер и процесс фикстуры', async (t) => {
  const fx = await fixture(t);
  const runtime = await createGlmFakeRuntime(t, {
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { text: framedResult } }],
  });
  const model = '["zai","glm-5.3"]';
  const target = await resolveArbiterTarget({
    config: runtime.config,
    modelRef: { provider: 'glm', model },
    modelsRegistry: async () => ({ glm: [{ id: model }] }),
    resolveRef: resolveModelRef,
    executorResolver: async () => runtime.adapter,
  });

  assert.equal(target.ok, true);

  await runArbiterConversation({
    ...fx,
    operationId: 'turn',
    input: {
      config: runtime.config,
      cwd: runtime.project,
      extraDirs: [],
      model: target.ref.model,
      permissionMode: target.permissionMode,
      providerSettings: {},
    },
    executor: target.executor,
    readCurrent: async () => fx.context,
  });

  const saved = await fx.store.read('7', fx.doc.id);

  assert.equal(saved.state, 'awaiting_user', JSON.stringify(saved.messages));
  assert.equal(saved.result.summary, result.summary);
  assert.ok(runtime.children.length > 0, 'Адаптер должен запустить процесс GLM');
});

test('отклонения оформления GLM сохраняют вопросы и предложения без повтора модели', async (t) => {
  const fx = await fixture(t);
  let calls = 0;
  const reply = {
    ...result,
    questions: [{
      ...result.questions[0],
      options: [{
        id: 'known',
        label: 'Причина известна',
        description: 'Есть журнал.',
      }],
    }],
    proposals: [{
      id: 'diagnose',
      kind: 'diagnose',
      label: 'Проверить журнал',
      recommended: true,
      expectedResult: 'Подтверждение причины.',
      diagnosticInstruction: 'Прочитай журнал.',
    }],
  };

  await runArbiterConversation({
    ...fx,
    operationId: 'turn',
    input: {},
    executor: { run: async () => {
      calls += 1;

      return { reply: `<arbiter-result>${JSON.stringify(reply)}</arbiter-result>` };
    } },
    readCurrent: async () => fx.context,
  });

  const saved = await fx.store.read('7', fx.doc.id);

  assert.equal(calls, 1);
  assert.equal(saved.state, 'awaiting_user');
  assert.equal(saved.operations[0].outcome, 'completed');
  assert.deepEqual(saved.result.questions[0].options, [{ id: 'known', label: 'Причина известна' }]);
  assert.equal(saved.result.proposals[0].explanation, 'Подтверждение причины.');
});

test('публичный текст сохранён до завершения executor; fallback не повторяет кадр', async (t) => {
  const fx = await fixture(t);
  let finish;
  let callbacks;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const running = runArbiterConversation({
    ...fx,
    operationId: 'turn',
    input: {},
    executor: {
      run: async (input) => {
        callbacks = input;

        return held;
      }
    },
    readCurrent: async () => fx.context,
    flushMs: 1
  });

  const deadline = Date.now() + 1000;

  while (!callbacks && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(Boolean(callbacks), true, 'runner должен начать executor');

  const text = '<arbiter-message>Читаю журнал.</arbiter-message>';

  callbacks.onAssistantMessage({
    assistantMessageId: 'source',
    text,
    sourceRevision: 2,
    complete: false
  });
  callbacks.onAssistantMessage({
    assistantMessageId: 'source',
    text: 'PRIVATE',
    sourceRevision: 1,
    complete: false
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal((await fx.store.read('7', fx.doc.id)).messages[0].text, 'Читаю журнал.');
  finish({ reply: text + framedResult });
  await running;

  const final = await fx.store.read('7', fx.doc.id);

  assert.equal(final.state, 'awaiting_user');
  assert.equal(final.result.summary, result.summary);
  assert.equal(final.messages.filter((row) => row.text === 'Читаю журнал.').length, 1);
  callbacks.onAssistantMessage({
    assistantMessageId: 'source',
    text: 'Поздний',
    sourceRevision: 3
  });
  assert.equal((await fx.store.read('7', fx.doc.id)).revision, final.revision);
});

test('невалидный result и timeout сохраняют публичный текст без активных действий', async (t) => {
  for (const timeout of [false, true]) {
    const fx = await fixture(t);

    await runArbiterConversation({
      ...fx,
      operationId: 'turn',
      input: {},
      flushMs: 1,
      timeoutMs: 15,
      executor: {
        run: async (input) => {
          input.onAssistantMessage({
            assistantMessageId: 'source',
            sourceRevision: 1,
            text: '<arbiter-message>Успел прочитать часть журнала.</arbiter-message>',
            complete: true
          });
          input.onAssistantMessage({
            assistantMessageId: 'partial',
            sourceRevision: 1,
            text: '<arbiter-message>Начал следующую проверку',
            complete: false,
          });

          return timeout ? new Promise(() => { }) : { reply: '<arbiter-result>{"shell":"rm"}' };
        }
      },
      readCurrent: async () => fx.context
    });

    const final = await fx.store.read('7', fx.doc.id);

    assert.equal(final.state, 'interrupted');
    assert.equal(final.result, null);
    assert.equal(final.messages.find((row) => row.sourceId === 'source').status, 'complete');
    assert.equal(final.messages.find((row) => row.sourceId === 'partial').status, 'interrupted');
    assert.equal(typeof final.operations[0].message, 'string');
    assert.match(final.messages.map((row) => row.text).join('\n'), /Успел прочитать часть/);
    assert.equal(final.messages.some((row) => row.text.includes('"shell"')), false);
  }
});

test('смена exact остановки оставляет итог только для чтения', async (t) => {
  const fx = await fixture(t);

  await runArbiterConversation({
    ...fx,
    operationId: 'turn',
    input: {},
    executor: { run: async () => ({ reply: framedResult }) },
    readCurrent: async () => null
  });

  assert.equal((await fx.store.read('7', fx.doc.id)).state, 'stale');
});
