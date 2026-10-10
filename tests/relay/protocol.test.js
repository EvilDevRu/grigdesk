import assert from 'node:assert/strict';
import test from 'node:test';

import { createLineReader, encodeReply, parseHello } from '../../relay/src/protocol.ts';

test('RL-04: роли hello и коды ошибок', () => {
  for (const role of ['health', 'brain-control', 'brain-data', 'device']) {
    const hello = {
      v: 1,
      role,
      token: 'token',
      id: 'a'.repeat(32),
    };

    assert.equal(parseHello(JSON.stringify(hello)).role, role);
  }

  for (const [value, code] of [
    ['[1]', 'bad_hello'],
    ['broken', 'bad_hello'],
    ['{"v":2,"role":"health"}', 'bad_version'],
    ['{"v":1,"role":"other"}', 'bad_role'],
    ['{"v":1,"role":"device"}', 'bad_hello'],
    ['{"v":1,"role":"brain-data","token":"x","id":"z"}', 'bad_hello'],
  ]) {
    assert.throws(
      () => parseHello(value),
      (error) => error.code === code,
    );
  }
});

test('RL-05/RL-28: фрагменты, UTF-8, хвост и ограничение строки', () => {
  const reader = createLineReader(32);

  assert.equal(reader.push(Buffer.from('пр')), null);

  const result = reader.push(Buffer.from('ивет\nTLS'));

  assert.equal(result.line, 'привет');
  assert.equal(result.rest.toString(), 'TLS');
  assert.throws(() => createLineReader(2).push(Buffer.from('abc')));
  assert.throws(() => createLineReader(2).push(Buffer.from([0xff, 10])));
});

test('RL-06: ответы имеют единственную строку JSON', () => {
  assert.equal(encodeReply({ ok: true }), '{"ok":true}\n');
  assert.equal(
    encodeReply({
      ok: false,
      error: 'busy',
    }),
    '{"ok":false,"error":"busy"}\n',
  );
});
