import assert from 'node:assert/strict';
import test from 'node:test';

import { sandboxUrl } from '../../web/src/shared/sandbox.ts';

test('LO-11: стенды открываются прямым HTTP-портом текущего хоста', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');

  t.after(() => {
    if (original) {
      Object.defineProperty(globalThis, 'location', original);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
  });

  for (const [origin, expected] of [
    ['https://c1.example.test/', 'http://c1.example.test:5191/'],
    ['http://localhost:8140/', 'http://localhost:5191/'],
    ['http://127.0.0.1:8140/', 'http://127.0.0.1:5191/'],
    ['http://[::1]:8140/', 'http://[::1]:5191/'],
  ]) {
    Object.defineProperty(globalThis, 'location', {
      value: new URL(origin!),
      configurable: true,
    });

    assert.equal(sandboxUrl(5191), expected);
  }

  Reflect.deleteProperty(globalThis, 'location');
  assert.equal(sandboxUrl(5191), 'http://localhost:5191/');

  for (const port of [undefined, null, 0, '']) {
    assert.equal(sandboxUrl(port), null);
  }
});
