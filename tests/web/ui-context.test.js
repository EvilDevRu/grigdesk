// Проверяет реестр UI-контекста: приоритеты источников, безопасный снимок и очистку.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiContextRegistry } from '../../web/src/stores/uiContext.ts';

const route = (path = '/pipeline', title = 'Конвейер') => ({
  path,
  fullPath: `${path}?token=secret#fragment`,
  meta: { title },
});

test('COMP-CTX-01/02: capture разделяет routing scope и глубоко фиксирует prompt context', () => {
  const registry = createUiContextRegistry();
  const value = { pipeline: { taskId: '123', stage: 'review' } };
  registry.register('pipeline', {
    layer: 'page',
    routingScope: { kind: 'task', taskId: '123' },
    details: value,
  });

  const snapshot = registry.capture(route());
  value.pipeline.stage = 'ship';

  assert.deepEqual(snapshot.routingScope, { kind: 'task', taskId: '123' });
  assert.deepEqual(snapshot.promptContext, {
    page: 'Конвейер',
    path: '/pipeline',
    details: { pipeline: { pipeline: { taskId: '123', stage: 'review' } } },
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.promptContext.details.pipeline.pipeline), true);
});

test('COMP-CTX-03/05/13: owner disposer не сносит новый source, overlay выше page, revision решает равенство', () => {
  const warnings = [];
  const registry = createUiContextRegistry({ warn: (event) => warnings.push(event) });
  const page = registry.register('task', {
    layer: 'page', routingScope: { kind: 'task', taskId: '1' }, details: { taskId: '1' },
  });
  const oldOverlay = registry.register('task', {
    layer: 'overlay', routingScope: { kind: 'task', taskId: '2' }, details: { taskId: '2' },
  });
  const newOverlay = registry.register('task', {
    layer: 'overlay', routingScope: { kind: 'task', taskId: '3' }, details: { taskId: '3' },
  });

  assert.deepEqual(registry.capture(route()).routingScope, { kind: 'task', taskId: '3' });
  oldOverlay.dispose();
  assert.deepEqual(registry.capture(route()).routingScope, { kind: 'task', taskId: '3' });
  newOverlay.dispose();
  assert.deepEqual(registry.capture(route()).routingScope, { kind: 'task', taskId: '1' });
  page.dispose();
  assert.equal(registry.capture(route()).routingScope, null);
  assert.ok(warnings.some((item) => item.code === 'duplicate_source'));
});

test('COMP-CTX-04/06/07: bad provider и недоверенные values отбрасываются fail-closed', () => {
  const warnings = [];
  const registry = createUiContextRegistry({ warn: (event) => warnings.push(event) });
  let getterCalls = 0;
  const hostile = Object.create(null);
  Object.defineProperty(hostile, 'boom', { enumerable: true, get() { getterCalls += 1; throw new Error('boom'); } });
  hostile.ok = 'safe';
  hostile.Token = 'never';
  hostile.deep = { cookie: 'never', command: 'rm', keep: 'yes' };
  hostile.fn = () => {};
  hostile.cycle = hostile;
  registry.register('hostile', { layer: 'page', details: hostile });
  registry.register('healthy', { layer: 'page', details: { selected: 'ok' } });

  const snapshot = registry.capture(route());
  assert.equal(getterCalls, 0);
  assert.deepEqual(snapshot.promptContext.details, {
    healthy: { selected: 'ok' },
    hostile: { deep: { keep: 'yes' }, ok: 'safe' },
  });
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every((item) => !JSON.stringify(item).includes('never')));
});

test('COMP-CTX-14: denylist применяется к source id до публикации details', () => {
  const warnings = [];
  const registry = createUiContextRegistry({ warn: (event) => warnings.push(event) });
  registry.register('Token', {
    layer: 'page',
    details: { value: 'must-not-reach-prompt' },
  });
  registry.register('settings', {
    layer: 'page',
    details: { tab: 'speech' },
  });

  const snapshot = registry.capture(route('/settings', 'Настройки'));
  assert.deepEqual(snapshot.promptContext.details, { settings: { tab: 'speech' } });
  assert.doesNotMatch(JSON.stringify(snapshot.promptContext), /Token|must-not-reach-prompt/i);
  assert.ok(warnings.some((item) => item.code === 'forbidden_source' && item.source === 'Token'));
});

test('COMP-CTX-08/12: caps и canonical pathname не пропускают query, длинные строки и oversized details', () => {
  const registry = createUiContextRegistry();
  registry.register('limits', {
    layer: 'page',
    details: {
      long: '🧭'.repeat(700),
      array: Array.from({ length: 80 }, (_, i) => i),
      huge: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 'x'.repeat(500)])),
    },
  });
  const snapshot = registry.capture(route('/settings'));
  assert.equal(snapshot.promptContext.path, '/settings');
  assert.doesNotMatch(JSON.stringify(snapshot.promptContext), /token=secret|fragment/);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.promptContext)) <= 8 * 1024);
  const kept = snapshot.promptContext.details?.limits;
  if (kept) {
    assert.ok([...kept.long].length <= 512);
    assert.ok(kept.array.length <= 32);
  }
});

test('COMP-CTX-09: register/update/dispose сами не вызывают API или model request', () => {
  let calls = 0;
  const registry = createUiContextRegistry({ effects: { request: () => { calls += 1; } } });
  const owner = registry.register('settings', { layer: 'page', details: { tab: 'speech' } });
  owner.update({ layer: 'page', details: { tab: 'server' } });
  owner.dispose();
  assert.equal(calls, 0);
});
