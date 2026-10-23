import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { decodePairing } from '../../shared/client/pairingPayload.ts';

const vectors = JSON.parse(await readFile(new URL(
  '../fixtures/phone-pairing-vectors.json', import.meta.url), 'utf8'));
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const qrcode = requireFromServer('qrcode-generator');
/**
 * Отсутствующий новый кодек является ожидаемым RED конкретного сценария.
 * Динамический импорт не превращает весь файл в ошибку загрузки node:test.
 */
async function codec() {
  return import('../../shared/client/phonePairing.ts');
}

for (const vector of vectors.valid) {
  test(`PHONE-01: ${vector.name}`, async () => {
    const { encodePhonePairing, decodePhonePairing } = await codec();
    const encoded = encodePhonePairing(vector.payload);

    assert.equal(encoded, vector.text);
    assert.deepEqual(decodePhonePairing(vector.text), vector.payload);
    assert.throws(() => decodePairing(vector.text));

    const qr = qrcode(0, 'M');

    qr.addData(encoded, 'Byte');
    assert.doesNotThrow(() => qr.make());
    assert.ok(qr.getModuleCount() > 0);
  });
}
for (const vector of vectors.invalid) {
  test(`PHONE-01: отклонён ${vector.name}`, async () => {
    const { decodePhonePairing } = await codec();

    assert.throws(() => decodePhonePairing(vector.text), undefined, vector.name);
  });
}

test('PHONE-01: v1 не меняет смысл и не принимается телефонным кодеком', async () => {
  const { decodePhonePairing } = await codec();
  const legacy = JSON.parse(await readFile(new URL(
    '../fixtures/pairing-vectors.json', import.meta.url), 'utf8'));

  for (const vector of legacy.valid) {
    assert.deepEqual(decodePairing(vector.text), vector.payload);
    assert.throws(() => decodePhonePairing(vector.text));
  }
});
