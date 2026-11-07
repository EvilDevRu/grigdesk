import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { getUiLayerDiagnostics, subscribeUiLayerDiagnostics }
  from '../../web/src/services/layers/stack.ts';
import { registerUiLayer, resetLayerStackForTests }
  from '../../web/src/services/layers/stack.ts';

test('диагностическая подписка видит open/close без сырого id', async () => {
  const facade = await readFile(new URL('../../web/src/ui.ts', import.meta.url), 'utf8');
  assert.match(facade, /getUiLayerDiagnostics, subscribeUiLayerDiagnostics/u);
  resetLayerStackForTests();
  let changes = 0;
  const off = subscribeUiLayerDiagnostics(() => { changes += 1; });
  const handle = registerUiLayer('private-id', { name: 'dialog', close: () => true });
  const items = getUiLayerDiagnostics();
  assert.equal(items[0].kind, 'dialog');
  assert.equal(typeof items[0].id, 'number');
  assert.deepEqual(Object.keys(items[0]).sort(), ['id', 'kind'], 'DOM-элемент наружу не отдаётся');
  assert.doesNotMatch(JSON.stringify(items), /private-id/u);
  handle.unregister();
  off();
  assert.equal(changes, 2);
});
