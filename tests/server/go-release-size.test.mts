import assert from 'node:assert/strict';
import test from 'node:test';

import { requireGoSizeReduction } from '../../tools/verifyGoReleaseSize.mts';

const download = {
  local: 103,
  remote: 80,
  server: 75,
};

test('GO-SIZE: меньшая загрузка не компенсирует рост или равенство tracker', () => {
  const a = {
    raw: 10,
    gzip: 7,
    download,
  };
  const c = {
    raw: 8,
    gzip: 6,
    download: {
      local: 100,
      remote: 78,
      server: 70,
    },
  };

  assert.doesNotThrow(() => requireGoSizeReduction(a, c));
  assert.throws(() => requireGoSizeReduction(a, { ...c, raw: 12 }), /tracker_raw/u);
  assert.throws(() => requireGoSizeReduction(a, { ...c, gzip: 7 }), /tracker_gzip/u);
  assert.throws(() => requireGoSizeReduction(a, { ...c, download: { ...c.download, remote: 80 } }),
    /remote/u);
  assert.throws(() => requireGoSizeReduction(a, { ...c, download: { ...c.download, server: 76 } }),
    /server/u);
});
