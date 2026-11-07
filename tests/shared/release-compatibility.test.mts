import assert from 'node:assert/strict';
import test from 'node:test';

import { checkReleaseCompatibility } from '../../shared/runtime/releaseCompatibility.ts';
import { signedIndex } from '../helpers/releaseV2Fixture.mjs';

const candidate = signedIndex().envelope.payload;

for (const [name, scope, remoteApi, installedRequirement, expected] of [
  ['пара достаточного minor', 'pair', undefined, undefined, true],
  ['remote достаточного minor', 'desktop', { major: 0, minor: 2 }, undefined, true],
  ['remote другого major', 'desktop', { major: 1, minor: 2 }, undefined, false],
  ['remote недостаточного minor', 'desktop', { major: 0, minor: 0 }, undefined, false],
  ['remote неизвестен', 'desktop', null, undefined, false],
  ['offline покрытый прежний диапазон', 'desktop', null, { major: 0, minMinor: 2 }, true],
  ['offline непокрытый диапазон', 'desktop', null, { major: 0, minMinor: 0 }, false],
  ['offline прежний другой major', 'desktop', null, { major: 1, minMinor: 2 }, false],
] as const) {
  test(`API-MATRIX: ${name}`, () => {
    const result = checkReleaseCompatibility({
      candidate,
      scope,
      remoteApi,
      installedRequirement,
    });

    assert.equal(result.compatible, expected);
    assert.equal(result.reason === null, expected);
  });
}

test('API-MATRIX: server-only сохраняет API старых desktop/Android 0.1', () => {
  for (const serverApi of [{ major: 1, minor: 1 }, { major: 0, minor: 0 }]) {
    const result = checkReleaseCompatibility({
      candidate: { ...candidate, serverApi },
      scope: 'server',
    });

    assert.equal(result.compatible, false);
  }

  assert.equal(checkReleaseCompatibility({ candidate, scope: 'server' }).compatible, true);
});
