process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { sheetSplit } from '../../web/src/features/studio3d/sheetSplit.ts';

/**
 * RGBA лист строится детерминированно: фон с лёгким шумом и три отдельные фигуры.
 * Проверка задаёт геометрию ожидаемого разреза, не повторяет алгоритм сканирования.
 */
function image(figures = [], noise = false) {
  const width = 300;
  const height = 100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  
  if (noise) {
    for (let index = 0; index < width * height; index += 7) {
      data[index * 4] = 251;
    }
  }
  
  for (const [x, y, w, h] of figures) {
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) {
        const index = (row * width + column) * 4;
        
        data[index] = 20;
        data[index + 1] = 20;
        data[index + 2] = 20;
      }
    }
  }
  
  return {
    width,
    height,
    data
  };
}

test('WC-06 три фигуры слева направо, шум не дробит, пустой лист без кусков', () => {
  const figures = [[20, 20, 40, 60], [120, 15, 30, 70], [220, 25, 40, 50]];
  const boxes = sheetSplit(image(figures));

  assert.equal(boxes.length, 3);
  assert.equal(boxes[0].x < 20 && boxes[0].x + boxes[0].width > 59, true);
  assert.equal(boxes[1].x < 120 && boxes[1].x + boxes[1].width > 149, true);
  assert.equal(boxes[2].x > boxes[1].x + boxes[1].width, true);
  assert.deepEqual(sheetSplit(image(figures, true)), boxes);
  assert.equal(sheetSplit(image([figures[0]])).length, 1);
  assert.deepEqual(sheetSplit(image()), []);
  assert.throws(() => sheetSplit({
    width: 100,
    height: 100,
    data: new Uint8Array(1)
  }), /размер/);
});

test('WC-07 размер PNG проверяется до native bitmap allocation', async (t) => {
  const { readStudioImage } = await import('../../web/src/features/studio3d/studioImages.ts');
  const { texturePng } = await import('./helpers/studio3d-viewer-fixtures.js');
  const bytes = Buffer.from(texturePng);
  const previous = globalThis.createImageBitmap;
  let decodes = 0;

  bytes.writeUInt32BE(10000, 16);
  bytes.writeUInt32BE(10000, 20);
  globalThis.createImageBitmap = async () => {
    decodes += 1;

    return {
      width: 10000,
      height: 10000,
      close() {}
    };
  };
  t.after(() => {
    globalThis.createImageBitmap = previous;
  });
  await assert.rejects(readStudioImage(new File([bytes], 'bomb.png', { type: 'image/png' })), /64|64Мп/);
  assert.equal(decodes, 0);
});
