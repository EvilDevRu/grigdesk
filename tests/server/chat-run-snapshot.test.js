import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeTurnCollector } from '../../server/src/lib/executors/_claudeStream.ts';
import { normalizeUsageResources } from '../../server/src/lib/providerUsage.ts';
import { parseDeepSeekBalance, deepSeekBalanceResources } from '../../server/src/lib/deepseek/balance.ts';
import { parseKimiUsageResources } from '../../server/src/lib/kimi/usage.ts';
import { chatAppFixture, controlledExecutor, saveChat, turnBody, waitFor }
  from './helpers/chat-turns.js';

for (const persistent of [false, true]) {
  test(`снимок и callback ${persistent ? 'persistent' : 'одноразового'} запуска восстанавливаются и защищены runId`,
    async (t) => {
      const controlled = controlledExecutor();

      if (persistent) {
        controlled.executor.session = {
          mode: 'persistent',
          async open(spec) {
            return {
              alive: true,
              send: (turn) => controlled.executor.run({ ...spec, ...turn }),
              async interrupt() {},
              async close() {},
            };
          },
        };
      }

      const { app, events } = await chatAppFixture(t, { executor: controlled.executor });

      await saveChat(app, 'snapshot-chat');
      await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: turnBody('snapshot-chat', 'turn-snapshot-a'),
      });
      const [first] = await controlled.waitForRuns(1);
      const started = events.find((event) => event.event === 'chat-turn-start').data;

      assert.equal(started.snapshot.requestedModelId, first.options.model);
      assert.equal(started.snapshot.cwd, first.options.cwd);
      assert.deepEqual(started.snapshot.extraDirs, first.options.extraDirs);
      assert.equal(started.snapshot.providerId, 'test-provider');
      assert.equal(started.snapshot.actualModelId, undefined);

      first.options.onRunMetadata({ actualModelId: 'model-confirmed', modelSource: 'session' });
      const active = (await app.inject('/api/chat/active')).json().active[0];

      assert.equal(active.snapshot.actualModelId, 'model-confirmed');
      assert.equal(active.snapshot.modelSource, 'session');
      first.release();
      await waitFor(() => events.some((event) => event.event === 'chat-done'));

      await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: turnBody('snapshot-chat', 'turn-snapshot-b'),
      });
      const [, second] = await controlled.waitForRuns(2);

      first.options.onRunMetadata({ actualModelId: 'wrong-old-model', modelSource: 'response' });
      first.options.onProgress(999);
      second.options.onRunMetadata({ actualModelId: 'model-b', modelSource: 'response' });
      second.options.onRunMetadata({ actualModelId: 'session-model-b', modelSource: 'session' });

      const current = (await app.inject('/api/chat/active')).json().active[0];

      assert.notEqual(current.runId, started.runId);
      assert.equal(current.snapshot.actualModelId, 'model-b');
      assert.equal(current.tokens, 0);
      assert.equal(events.some((event) => event.event === 'chat-progress' && event.data.tokens === 999), false);
      second.release();
      await waitFor(() => events.filter((event) => event.event === 'chat-done').length === 2);
      assert.deepEqual(events.filter((event) => event.event === 'chat-done').map((event) => event.data.runId),
        [started.runId, current.runId]);
    });
}

test('Claude подтверждает только модель основного агента и различает init и ответ', () => {
  const metadata = [];
  const collector = createClaudeTurnCollector({ onRunMetadata: (value) => metadata.push(value) });

  collector.push({
    type: 'system',
    subtype: 'init',
    model: 'session-model',
  });
  collector.push({
    type: 'assistant',
    parent_tool_use_id: 'child',
    message: { model: 'child-model' },
  });
  collector.push({ type: 'assistant', message: { model: '<synthetic>' } });
  collector.push({ type: 'assistant', message: { model: 'response-model' } });

  assert.deepEqual(metadata, [
    { actualModelId: 'session-model', modelSource: 'session' },
    { actualModelId: 'response-model', modelSource: 'response' },
  ]);
});

test('балансы не подставляют ноль вместо отсутствия и сохраняют отрицательные суммы', () => {
  for (const value of [null, '', 'broken', false, Infinity]) {
    const parsed = parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: value }] });
    const resources = deepSeekBalanceResources(parsed, []);
    const kimi = parseKimiUsageResources({ kind: 'ok', extra_usage: { currency: 'USD', balance_cents: value } });

    assert.equal(resources[0].balance, undefined);
    assert.equal(kimi[0].balance, undefined);
  }

  const parsed = parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: '-1.25' }] });
  const resources = normalizeUsageResources(deepSeekBalanceResources(parsed, []));
  const kimi = normalizeUsageResources(parseKimiUsageResources({
    kind: 'ok', extra_usage: { currency: 'CNY', balance_cents: -125 },
  }));

  assert.deepEqual(resources[0].balance, { amount: -1.25, currency: 'USD' });
  assert.deepEqual(kimi[0].balance, { amount: -1.25, currency: 'CNY' });
  assert.equal(normalizeUsageResources([{
    key: 'test',
    label: 'Баланс',
    kind: 'balance',
    balance: { amount: '0', currency: 'USD' },
  }])[0].balance, undefined);
});
