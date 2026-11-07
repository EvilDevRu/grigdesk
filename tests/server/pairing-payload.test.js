import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { decodePairing, encodePairing } from '../../shared/client/pairingPayload.ts';

const vectorsUrl = new URL('../fixtures/pairing-vectors.json', import.meta.url);
const vectors = JSON.parse(readFileSync(vectorsUrl, 'utf8'));
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const qrcode = requireFromServer('qrcode-generator');

test('привязка: общие векторы кодируются, декодируются и допускают регистр/краевые пробелы', () => {
  for (const vector of vectors.valid) {
    assert.equal(encodePairing(vector.payload), vector.text, vector.name);
    assert.deepEqual(decodePairing(vector.text), vector.payload, vector.name);
    assert.deepEqual(decodePairing(`  ${vector.text.toLowerCase()}  `), vector.payload);
  }
});

test('привязка: недопустимые векторы отвергаются с кодом ошибки', () => {
  for (const vector of vectors.invalid) {
    assert.throws(() => decodePairing(vector.text), { code: vector.code }, vector.name);
  }
});

test('привязка: IPv4 занимает 117 символов и помещается в QR версии 5 уровня M', () => {
  const text = encodePairing(vectors.valid[0].payload);
  const qr = qrcode(0, 'M');

  assert.equal(text.length, 117);
  qr.addData(text, 'Alphanumeric');
  qr.make();
  assert.ok(qr.getModuleCount() <= 37);
});
