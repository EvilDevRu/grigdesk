import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareExternalCliRuntime } from '../../server/src/lib/providerInstall/externalCliRuntime.ts';
import { withExternalCliProcess } from '../../server/src/lib/providerInstall/externalCliProcess.ts';
import rawQwen from '../../server/src/lib/executors/qwen.ts';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { runInput, until } from '../helpers/qwenFixture.mjs';

/**
 * Реальный CLI использует локальный синтетический API и отдельный временный HOME.
 * Reader lease и native user scope проходят штатный Host launcher.
 */
async function openNative(t) {
  const fixture = await qwenNativeFixture(t);
  const activity = [];
  const prepared = await prepareExternalCliRuntime(rawQwen, fixture.config);
  const spec = runInput(fixture, 'shared-model(openai)', {
    config: prepared.config,
    permissionMode: 'yolo',
    providerSettings: { allowHostAccess: true },
    hooks: { onActivity: (value) => activity.push(value) },
  });
  const handle = await withExternalCliProcess(prepared.process, () => rawQwen.session.open(spec));

  t.after(() => handle.close());

  return {
    fixture,
    handle,
    activity,
    async reopen(sessionId) {
      const reopened = await withExternalCliProcess(prepared.process, () =>
        rawQwen.session.open({ ...spec, sessionId }));

      t.after(() => reopened.close());

      return reopened;
    },
  };
}

test('Qwen native idle: полный статус разрешает подтверждённое закрытие пустой сессии', {
  timeout: 45000,
}, async (t) => {
  const h = await openNative(t);

  const first = await h.handle.send({ message: 'Обычный ответ.', signal: AbortSignal.timeout(20000) });

  await until(() => h.activity.some((value) => value.state === 'idle'), 'native idle', 12000);
  assert.equal(await h.handle.closeIfIdle(), true);
  assert.equal(h.handle.alive, false);

  const resumed = await h.reopen(first.sessionId);
  const next = await resumed.send({ message: 'Продолжи.', signal: AbortSignal.timeout(20000) });

  assert.equal(next.sessionId, first.sessionId, 'Автоуборка сохраняет native память разговора');
});

test('Qwen native idle: ожидающий wakeup удерживает процесс и виден до своего запуска', {
  timeout: 45000,
}, async (t) => {
  const h = await openNative(t);
  const action = { name: 'loop_wakeup', args: { delaySeconds: 1200, prompt: '/loop synthetic wakeup' } };

  h.fixture.actions.push(action);
  await h.handle.send({ message: 'Назначь пробуждение.', signal: AbortSignal.timeout(20000) });
  assert.equal(action.missing, undefined);
  await until(() => h.activity.some((value) => value.reasons.some((reason) => reason.kind === 'schedule')),
    'native расписание до запуска', 12000);
  assert.equal(await h.handle.closeIfIdle(), false);
  assert.equal(h.handle.alive, true);
});

test('Qwen native idle: cron в будущем удерживает процесс между срабатываниями', {
  timeout: 45000,
}, async (t) => {
  const h = await openNative(t);
  const action = {
    name: 'cron_create',
    args: {
      cron: '0 0 1 1 *',
      prompt: 'synthetic future reminder',
      recurring: false,
    },
  };

  h.fixture.actions.push(action);
  await h.handle.send({ message: 'Назначь будущее напоминание.', signal: AbortSignal.timeout(20000) });
  assert.equal(action.missing, undefined);
  await until(() => h.activity.some((value) => value.reasons.some((reason) => reason.kind === 'schedule')),
    'native cron до запуска', 12000);
  assert.equal(await h.handle.closeIfIdle(), false);
  assert.equal(h.handle.alive, true);
});
