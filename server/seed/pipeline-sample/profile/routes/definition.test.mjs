import assert from 'node:assert/strict';
import test from 'node:test';

import { kit } from './routes-kit.mjs';
import { profile } from './common.mjs';
import { definitions, bootstrap, bootstrapPrompts } from './definition.mjs';

// Сторож публичных правил запускается и в копии профиля, и обёрткой server tests.
// Он фиксирует права и невозможность принять пропуск как успешное выполнение.
test('Образец сохраняет командную проверку, ворота и остановку при пропуске', () => {
  for (const [routeId, { route, prompts }] of Object.entries(definitions)) {
    kit.validateRoute(route, {
      profile,
      routeId,
      promptFiles: Object.keys(prompts),
    });
    assert.equal(route.bootstrap, 'skip');
    assert.equal(route.nodes.find((node) => node.id === 'verify').executor, 'command');
    assert.equal(route.nodes.find((node) => node.id === 'gate_accept').executor, 'gate');

    for (const node of route.nodes.filter((item) => item.executor !== 'gate')) {
      assert.deepEqual(node.on.skipped, { stop: 'human' });
      assert.deepEqual(node.onFailure.environment, { stop: 'human' });
      assert.deepEqual(node.onFailure.human, { stop: 'human' });
      assert.equal(node.retry.productFailure, 0);
    }
  }

  kit.validateBootstrap(bootstrap, { profile, promptFiles: Object.keys(bootstrapPrompts) });
});
