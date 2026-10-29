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
    ['http://127.0.0.1:8140/', 'http://localhost:5191/'],
    ['http://[::1]:8140/', 'http://localhost:5191/'],
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

test('хост профиля сохраняет локальный вход независимо от origin GrigDesk', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');

  t.after(() => {
    if (original) {
      Object.defineProperty(globalThis, 'location', original);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
  });

  Object.defineProperty(globalThis, 'location', {
    value: new URL('http://127.0.0.1:8140/'), configurable: true,
  });

  assert.equal(sandboxUrl(5191, 'localhost'), 'http://localhost:5191/');
  assert.equal(sandboxUrl(5191, 'app.example.test'), 'http://app.example.test:5191/');
  assert.equal(sandboxUrl(5191, '[::1]'), 'http://[::1]:5191/');

  for (const invalid of ['https://other.test', 'other.test:80', 'user@other.test', 'host/path', '$(echo host)']) {
    assert.equal(sandboxUrl(5191, invalid), 'http://localhost:5191/');
  }
});
