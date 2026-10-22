import assert from 'node:assert/strict';
import test from 'node:test';

import { kimiUsageWire } from '../helpers/kimiUsageWire.mjs';
import { runKimiServerTurn } from '../../server/src/lib/kimi/serverTurn.ts';

for (const sessionId of [undefined, 'usage-session']) {
  test(`native Bash обязан быть закрыт до prompt, resume=${Boolean(sessionId)}`, async (t) => {
    let prompts = 0;
    const wire = await kimiUsageWire(t, [(send) => {
      prompts += 1;
      send({ type: 'turn.ended', reason: 'completed' });
    }]);
    const server = await wire.startServer();

    const order = [];

    server.client.snapshot = async () => {
      order.push('load');

      return {};
    };
    server.client.tools = async () => {
      order.push('check');

      return { tools: [{ name: 'Bash', active: true }] };
    };

    await assert.rejects(runKimiServerTurn({
      bin: 'fake',
      home: '/fixture',
      message: 'Обычный вопрос',
      sessionId,
      controlledCommands: true,
      startServer: async () => server,
    }), /kimi_native_bash_not_disabled/);
    assert.equal(prompts, 0);
    assert.deepEqual(order, sessionId ? ['load', 'check'] : ['check']);
  });
}

for (const response of [{}, { tools: [] }, { tools: [{ name: 'Bash' }] }, null]) {
  test(`неполное доказательство native запрета закрывает prompt: ${JSON.stringify(response)}`, async (t) => {
    let prompts = 0;
    const wire = await kimiUsageWire(t, [(send) => {
      prompts += 1;
      send({ type: 'turn.ended', reason: 'completed' });
    }]);
    const server = await wire.startServer();

    server.client.tools = async () => {
      if (response === null) {
        throw new Error('Нет tools API');
      }

      return response;
    };

    await assert.rejects(runKimiServerTurn({
      bin: 'fake',
      home: '/fixture',
      message: 'Обычный вопрос',
      controlledCommands: true,
      startServer: async () => server,
    }));
    assert.equal(prompts, 0);
  });
}

test('закрытый Bash допускает обычный ответ, проверка идёт после native settings', async (t) => {
  const order = [];
  const wire = await kimiUsageWire(t, [(send) => {
    order.push('prompt');
    send({ type: 'assistant.delta', delta: 'Ответ.' });
    send({ type: 'turn.ended', reason: 'completed' });
  }]);
  const server = await wire.startServer();

  server.client.updateSettings = async () => {
    order.push('settings');

    return { future: false };
  };
  server.client.tools = async () => {
    order.push('check');

    return { tools: [{ name: 'Bash', active: false }] };
  };

  const result = await runKimiServerTurn({
    bin: 'fake',
    home: '/fixture',
    message: 'Обычный вопрос',
    nativeSettings: {
      providerId: 'kimi',
      contextFingerprint: 'fixture',
      schemaRevision: 'fixture',
      storageRevision: '1',
      fingerprint: 'false',
      payload: { future: false },
      accepted: [{
        fieldId: '["future"]',
        path: ['future'],
        value: false,
        channelId: 'isolated-config-post',
      }],
    },
    controlledCommands: true,
    startServer: async () => server,
  });

  assert.equal(result.reply, 'Ответ.');
  assert.deepEqual(order, ['settings', 'check', 'prompt']);
});
