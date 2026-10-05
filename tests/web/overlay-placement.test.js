import assert from 'node:assert/strict';
import test from 'node:test';

import { computeOverlayPlacement } from '../../web/src/services/overlayPlacement.ts';

const base = {
  trigger: {
    left: 100,
    top: 100,
    right: 140,
    bottom: 120,
    width: 40,
    height: 20,
  },
  surface: { width: 80, height: 30 },
  viewport: { width: 400, height: 300 },
  placement: 'top',
  offset: 9,
};

test('TIP-POS-01: сверху и по центру', () => {
  assert.deepEqual(computeOverlayPlacement(base), {
    placement: 'top',
    left: 80,
    top: 61,
    anchorX: 40,
    anchorY: 49,
  });
});

test('TIP-POS-02: дефицит места переворачивает поверхность', () => {
  const result = computeOverlayPlacement({
    ...base,
    trigger: {
      ...base.trigger,
      top: 5,
      bottom: 25,
    },
  });

  assert.equal(result.placement, 'bottom');
  assert.equal(result.top, 34);
});

test('TIP-POS-03: правый край поджимает bottom-start', () => {
  const result = computeOverlayPlacement({
    ...base,
    placement: 'bottom-start',
    trigger: {
      ...base.trigger,
      left: 350,
      right: 390,
    },
  });

  assert.equal(result.left, 312);
});

test('TIP-POS-04: right-end выравнивается по нижнему краю', () => {
  const result = computeOverlayPlacement({ ...base, placement: 'right-end' });

  assert.equal(result.left, 149);
  assert.equal(result.top, 90);
});

test('TIP-POS-05: якорь относительно поверхности, большие размеры конечны', () => {
  const result = computeOverlayPlacement({
    ...base,
    surface: { width: 500, height: 500 },
  });

  assert.equal(result.left, 8);
  assert.equal(result.top, 8);
  assert.equal(result.anchorX, 112);
  assert.equal(result.anchorY, 102);

  const numbers = Object.values(result).filter((value) => typeof value === 'number');

  assert.equal(numbers.every(Number.isFinite), true);
});
