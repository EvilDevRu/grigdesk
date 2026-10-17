import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSplat } from '../../web/src/shared/viewer3d/splat.ts';

test('WV-01 splat: полные записи, позиции/RGBA и неполный хвост', () => {
  const bytes = new Uint8Array(67);
  const view = new DataView(bytes.buffer);
  
  view.setFloat32(0, 1, true);
  view.setFloat32(4, 2, true);
  view.setFloat32(8, 3, true);
  bytes.set([255, 10, 20, 200], 24);
  
  const parsed = parseSplat(bytes);
  
  assert.equal(parsed.count, 2);
  assert.deepEqual([...parsed.positions.slice(0, 3)], [1, 2, 3]);
  assert.deepEqual([...parsed.colors.slice(0, 4)], [255, 10, 20, 200]);
  view.setFloat32(0, NaN, true);
  assert.throws(() => parseSplat(bytes), /координат/);
});
