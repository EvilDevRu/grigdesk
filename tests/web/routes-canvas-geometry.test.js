import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const geometry = await compileModule(webFile('src/views/routes/routeCanvasGeometry.ts'));

test('RE-G4-05: CTM учитывает scale/translation, снимок остаётся независимым', () => {
  const inverse = {
    a: 0.5,
    b: 0,
    c: 0,
    d: 0.5,
    e: -50,
    f: -20
  };
  const svg = { getScreenCTM: () => ({ inverse: () => inverse }) };
  const transform = geometry.captureCanvasTransform(svg);

  inverse.e = 900;
  assert.deepEqual(geometry.canvasPoint({ clientX: 300, clientY: 160 }, transform),
    { x: 100, y: 60 });
});

test('RE-G4-06: fallback учитывает xMidYMid meet и даёт identity без layout', () => {
  const svg = {
    getAttribute: () => '10 20 200 100',
    getBoundingClientRect: () => ({
      left: 30,
      top: 40,
      width: 400,
      height: 400
    }),
  };
  const transform = geometry.captureCanvasTransform(svg);

  // SVG 200×100 вписан с масштабом 2 и пустыми полосами по 100 px сверху/снизу.
  assert.deepEqual(geometry.canvasPoint({ clientX: 230, clientY: 240 }, transform),
    { x: 110, y: 70 });
  assert.deepEqual(geometry.canvasPoint({ clientX: 17, clientY: 23 },
    geometry.captureCanvasTransform(null)), { x: 17, y: 23 });
});
