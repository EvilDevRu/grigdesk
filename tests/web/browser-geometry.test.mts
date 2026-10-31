import assert from 'node:assert/strict';
import test from 'node:test';
import { browserRect } from '../../web/src/shared/browser/browserGeometry.ts';

test('BR08: любой overlay скрывает guest, границы округляются внутрь viewport', () => {
  const rect = {
    left: -10,
    top: 40.2,
    right: 900.7,
    bottom: 700.9
  };

  assert.equal(browserRect(rect, { width: 800, height: 600 }, true, 1), null);
  assert.equal(browserRect(rect, { width: 800, height: 600 }, false, 0), null);
  assert.deepEqual(browserRect(rect, { width: 800, height: 600 }, true, 0), {
    x: 0,
    y: 41,
    width: 800,
    height: 559,
  });
});
