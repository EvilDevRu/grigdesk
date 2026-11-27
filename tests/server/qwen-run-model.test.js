import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';

import { qwenSelectedModel } from '../../server/src/lib/qwen/modelMetadata.ts';
import { qwenPreviewModelId } from '../../server/src/lib/qwen/previewModels.ts';
import { runQwenTurn } from '../../server/src/lib/qwen/runtime.ts';
import { readQwenSnapshot } from '../../server/src/lib/qwen/settings.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenAdapter, qwenFixture, runInput } from '../helpers/qwenFixture.mjs';

test('Qwen передаёт подтверждённую CLI модель до prompt и сохраняет её при resume', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = 'second-model(openai)';
  const reports = [];
  let sessionSaved = false;

  fixture.settings.modelProviders.openai.push({
    ...fixture.settings.modelProviders.openai[0],
    id: 'second-model',
  });
  await fixture.writeSettings(fixture.settings);

  const callbacks = {
    onSessionCreated: () => {
      sessionSaved = true;
    },
    onRunMetadata: (metadata) => {
      assert.equal(sessionSaved, true);
      reports.push(metadata);
    },
    onStep: (step) => {
      if (step.k === 'start') {
        assert.equal(reports.at(-1)?.actualModelId, model);
      }
    },
  };
  const first = await adapter.run(runInput(fixture, model, callbacks));

  sessionSaved = false;

  const second = await adapter.run(runInput(fixture, model, {
    ...callbacks,
    sessionId: first.sessionId,
  }));

  assert.equal(first.actualModel, model);
  assert.equal(second.actualModel, model);
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(fixture.requests.length >= 2);
  assert.ok(fixture.requests.every((request) => request.model === 'second-model'));
  assert.deepEqual(reports, [
    { actualModelId: model, modelSource: 'session' },
    { actualModelId: model, modelSource: 'session' },
  ]);
});

test('Qwen Preview.2 отклоняет чужую модель до prompt и игнорирует кадр другой сессии', async (t) => {
  const fixture = await qwenFixture(t);
  const snapshot = readQwenSnapshot(fixture.config);
  const requested = snapshot.models[0];
  const selectedId = qwenPreviewModelId(requested);
  const foreign = qwenPreviewModelId(snapshot.models[1]);
  const calls = [];

  /**
   * Подменён только результат RPC. Runner проверяет model option до первого prompt
   * и отбрасывает чужие кадры действующей сессии по её идентификатору.
   */
  function transportFor(currentValue) {
    const modelOptions = (value) => [{
      id: 'model',
      type: 'select',
      currentValue: value,
    }];

    return async (_config, _snapshot, options, handlers) => {
      await mkdir(options.home, { recursive: true });

      return {
        close: async () => {},
        stderr: () => '',
        client: {
          /**
           * Запоминаем вызовы до prompt. Кадр другой ACP-сессии отправляется только
           * после подтверждения выбранной модели и получения первого запроса пользователя.
           */
          async request(method) {
            calls.push(method);

            if (method === 'session/new') {
              return { sessionId: 'synthetic-session', configOptions: modelOptions(currentValue) };
            }

            assert.equal(method, 'session/prompt');
            await handlers.onNotification('session/update', {
              sessionId: 'foreign-session',
              update: { sessionUpdate: 'config_option_update', configOptions: modelOptions(foreign) },
            });
            await handlers.onNotification('session/update', {
              sessionId: 'synthetic-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Ответ' } },
            });

            return { stopReason: 'end_turn' };
          },
        },
      };
    };
  }

  for (const invalid of [undefined, foreign]) {
    await assert.rejects(runQwenTurn(runInput(fixture, requested.id), {
      openTransport: transportFor(invalid),
    }), /CLI не подтвердил выбранную модель/);
  }

  const result = await runQwenTurn(runInput(fixture, requested.id), {
    openTransport: transportFor(selectedId),
  });

  assert.equal(result.reply, 'Ответ');
  assert.equal(result.actualModel, requested.id);
  assert.deepEqual(calls, ['session/new', 'session/new', 'session/new', 'session/prompt']);
});

test('Qwen читает текущую модель из metadata, не подставляя доступные варианты', () => {
  const options = [{
    id: 'model',
    type: 'select',
    currentValue: ' effective-model(openai) ',
    options: [{ value: 'requested-model(openai)' }],
  }];

  assert.equal(qwenSelectedModel(options), 'effective-model(openai)');
  assert.equal(qwenSelectedModel(undefined), '');
  assert.equal(qwenSelectedModel([{ ...options[0], currentValue: undefined }]), '');
  assert.equal(qwenSelectedModel([{ ...options[0], currentValue: 42 }]), '');
  assert.equal(qwenSelectedModel([{ ...options[0], type: 'boolean' }]), '');
});
