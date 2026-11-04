import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatAppFixture, controlledExecutor, saveChat, turnBody, waitFor }
  from './helpers/chat-turns.js';

/**
 * Настройка меняется тем же CAS PUT, что у окна; скорость не передаётся model prompt.
 * Свежая revision берётся с диска, чтобы тест не обходил реальную границу хранения.
 */
async function choose(app, id, speed) {
  const current = (await app.inject(`/api/chat/store/chat/${id}`)).json().chat;
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: { ...current, speed } },
  });

  assert.equal(saved.statusCode, 200, saved.body);
}

for (const speed of ['fast', 'ultrafast']) {
  test(`SPEED-QUEUE: ${speed} busy snapshot прежний, следующий ход свежий`, async (t) => {
    const control = controlledExecutor();

    control.executor.chatSpeed = {
      modes: ['standard', 'fast', 'ultrafast'],
      apply(settings, speed) {
        return { ...settings, nativeSpeed: speed };
      },
    };

    const { app, events } = await chatAppFixture(t, {
      executor: control.executor,
      modelsRegistry: async () => ({
        'test-provider': [{
        id: 'test-model',
        efforts: [],
        chatSpeedModes: ['standard', 'fast', 'ultrafast'],
      }],
      }),
    });

    await saveChat(app, 'speed-queue');
    await choose(app, 'speed-queue', speed);

    const first = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody('speed-queue', 'speed-turn-0001'),
    });

    assert.equal(first.statusCode, 202);
    await control.waitForRuns(1);
    assert.equal(control.runs[0].options.providerSettings.nativeSpeed, speed);

    const second = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody('speed-queue', 'speed-turn-0002', 'следующий'),
    });

    assert.equal(second.statusCode, 202);
    await choose(app, 'speed-queue', 'standard');
    assert.equal(control.runs[0].options.providerSettings.nativeSpeed, speed);
    control.runs[0].release();
    await control.waitForRuns(2);
    assert.equal(control.runs[1].options.providerSettings.nativeSpeed, 'standard');
    control.runs[1].release();
    await waitFor(() => events.filter((event) => event.event === 'chat-done').length === 2);
  });


  test(`SPEED-INPUT: неподдерживаемый ${speed} не запускает executor`, async (t) => {
    const control = controlledExecutor();

    control.executor.chatSpeed = { modes: ['standard', 'fast', 'ultrafast'], apply: (settings) => settings };

    const { app, events } = await chatAppFixture(t, { executor: control.executor });

    await saveChat(app, 'speed-unsupported');
    await choose(app, 'speed-unsupported', speed);

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody('speed-unsupported', 'speed-invalid-0001'),
    });

    assert.equal(response.statusCode, 202);
    await waitFor(() => control.runs.length > 0 || events.some((event) => event.event === 'chat-done'
      && event.data.turnId === 'speed-invalid-0001'));
    assert.equal(control.runs.length, 0);

    const pending = (await app.inject('/api/chat/pending')).json().pending;

    assert.match(pending.find((item) => item.turnId === 'speed-invalid-0001').reply, /ускорение|скорост/iu);
    assert.equal(events.filter((event) => event.event === 'chat-done'
      && event.data.turnId === 'speed-invalid-0001').length, 1);
  });
}

for (const speed of [undefined, null, 'standard']) {
  test(`SPEED-LEGACY: snapshot ${String(speed)} не меняет общий default`, async (t) => {
    const control = controlledExecutor();
    const saved = { keep: 1, fastMode: true };

    control.executor.chatSpeed = {
      modes: ['standard', 'fast'],
      apply(settings, choice) {
        return { ...settings, fastMode: choice === 'fast' };
      },
    };

    const { app } = await chatAppFixture(t, {
      executor: control.executor, prefs: { providerSettings: { 'test-provider': saved } },
    });

    await saveChat(app, 'speed-legacy');

    if (speed !== undefined) {
      await choose(app, 'speed-legacy', speed);
    }

    await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody('speed-legacy', 'speed-legacy-0001', 'привет', {
        speed: 'fast',
        fastMode: true,
        service_tier: 'ultrafast',
      }),
    });
    await control.waitForRuns(1);
    assert.equal(control.runs[0].options.providerSettings.fastMode, speed !== 'standard');
    assert.equal(control.runs[0].options.providerSettings.keep, 1);
    assert.deepEqual(saved, { keep: 1, fastMode: true });
    control.runs[0].release();
  });
}

test('SPEED-MOBILE-NEXT: смена на несовместимую модель не блокирует следующий ход', async (t) => {
  const control = controlledExecutor();
  const models = { 'test-provider': [
    {
      id: 'test-model',
      efforts: [],
      chatSpeedModes: ['standard', 'fast'],
    },
    {
      id: 'slow-model',
      efforts: [],
      chatSpeedModes: ['standard'],
    },
  ] };
  const { app } = await chatAppFixture(t, {
    executor: control.executor,
    modelsRegistry: async () => models,
  });

  await saveChat(app, 'speed-mobile-next');
  await choose(app, 'speed-mobile-next', 'fast');

  const current = (await app.inject('/api/chat/store/chat/speed-mobile-next')).json().chat;
  const modelRef = { provider: 'test-provider', model: 'slow-model' };
  const changed = await app.mobileChat.controls.configure(current.id, {
    expectedRevision: current.revision,
    modelRef,
    effort: '',
    reset: true,
  });

  assert.equal(changed.speed, 'standard');

  const response = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody(current.id, 'speed-mobile-next-0001', 'привет', { modelRef }),
  });

  assert.equal(response.statusCode, 202);
  await control.waitForRuns(1);
  assert.equal(control.runs[0].options.model, 'slow-model');
  control.runs[0].release();
});


test('SPEED-CORRUPT: повреждённая durable скорость отказывает до model prompt', async (t) => {
  const control = controlledExecutor();
  const { app, config, events } = await chatAppFixture(t, { executor: control.executor });

  await saveChat(app, 'speed-corrupt');

  const history = new ChatHistoryStore({ chatsDir: config.chatsDir });

  // Серверный patch моделирует уже повреждённый файл, обходя валидатор клиентского PUT.
  // Сам запуск читает настоящий durable record, а fake executor остаётся наблюдаемым.
  await history.patchExecution('speed-corrupt', () => ({ speed: 'warp' }), { durable: true });

  const response = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('speed-corrupt', 'speed-corrupt-0001'),
  });

  assert.equal(response.statusCode, 202);
  await waitFor(() => control.runs.length > 0 || events.some((event) => event.event === 'chat-done'
    && event.data.turnId === 'speed-corrupt-0001'));
  assert.equal(control.runs.length, 0);

  const pending = (await app.inject('/api/chat/pending')).json().pending;

  assert.match(pending.find((item) => item.turnId === 'speed-corrupt-0001').reply, /скорость/iu);
});
