import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

      const { app, events, root } = await chatAppFixture(t, { executor: controlled.executor });

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
      // Папка артефактов открыта агенту, но в снимке хода, как и вложения, не показывается.
      assert.deepEqual(started.snapshot.extraDirs,
        first.options.extraDirs.filter((dir) => dir !== path.join(root, 'artifacts')));
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

test('папка вложений открыта агенту, но не показывается в снимке хода', async (t) => {
  const controlled = controlledExecutor();
  const { app, events, root } = await chatAppFixture(t, { executor: controlled.executor });

  await saveChat(app, 'attach-chat');

  const attachments = path.join(root, 'chats', 'attachments');

  await fs.mkdir(attachments, { recursive: true });
  await fs.writeFile(path.join(attachments, 'shot.png'), 'png');
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('attach-chat', 'turn-attach-0001', 'смотри', { attachments: [{ file: 'shot.png' }] }),
  });

  const [run] = await controlled.waitForRuns(1);
  const started = events.find((event) => event.event === 'chat-turn-start').data;

  assert.equal(run.options.extraDirs.includes(path.resolve(attachments)), true);
  assert.ok(run.options.message.includes(path.join(attachments, 'shot.png')));
  assert.match(run.options.message, /Изображения открой подходящим инструментом чтения изображений/u);
  assert.match(run.options.message, /Read или read_image — что доступно в этом окружении/u);
  assert.equal(started.snapshot.extraDirs.includes(path.resolve(attachments)), false);
  const active = (await app.inject('/api/chat/active')).json().active[0];

  assert.equal(active.snapshot.extraDirs.includes(path.resolve(attachments)), false);
  run.release();
  await waitFor(() => events.some((event) => event.event === 'chat-done'));
});

test('общая папка артефактов открыта агенту на запись, но не показывается в снимке хода', async (t) => {
  const controlled = controlledExecutor();

  // Папку получает только адаптер, объявивший несколько корней, как Claude и Codex.
  controlled.executor.workdir = { switch: 'resume', roots: 'multi' };

  const { app, events, root } = await chatAppFixture(t, { executor: controlled.executor });
  const artifacts = path.join(root, 'artifacts');

  await saveChat(app, 'artifacts-chat');
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('artifacts-chat', 'turn-artifacts-0001', 'сделай снимок'),
  });

  const [run] = await controlled.waitForRuns(1);
  const started = events.find((event) => event.event === 'chat-turn-start').data;
  const active = (await app.inject('/api/chat/active')).json().active[0];

  assert.equal(run.options.extraDirs.includes(artifacts), true);
  assert.equal((await fs.stat(artifacts)).isDirectory(), true);
  assert.equal(started.snapshot.extraDirs.includes(artifacts), false);
  assert.equal(active.snapshot.extraDirs.includes(artifacts), false);
  run.release();
  await waitFor(() => events.some((event) => event.event === 'chat-done'));
});

test('однокорневой исполнитель папку артефактов не получает: его граница — рабочая папка', async (t) => {
  for (const workdir of [{ switch: 'reseed', roots: 'single' }, undefined]) {
    const controlled = controlledExecutor();

    controlled.executor.workdir = workdir;

    const { app, events, root } = await chatAppFixture(t, { executor: controlled.executor });

    await saveChat(app, 'single-chat');
    await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody('single-chat', 'turn-single-0001', 'сделай снимок'),
    });

    const [run] = await controlled.waitForRuns(1);

    assert.equal(run.options.extraDirs.includes(path.join(root, 'artifacts')), false, String(workdir?.roots));
    run.release();
    await waitFor(() => events.some((event) => event.event === 'chat-done'));
  }
});
