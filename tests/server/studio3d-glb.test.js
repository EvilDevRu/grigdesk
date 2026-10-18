import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FACE_PLUS_X,
  GlbError,
  facingOf,
  imageSize,
  inspectGlb,
  parseGlb,
  wrapGlb,
} from '../../server/src/lib/studio3d/glb.ts';
import { makeGlb, pngHeader } from './helpers/studio3dGlb.js';

/**
 * Переписывает JSON-чанк собранного GLB, сохраняя бинарный чанк как есть.
 * Нужна для сценариев с режимами примитивов и битыми полями.
 */
function patchJson(bytes, patch) {
  const { json, bin } = parseGlb(bytes);
  const next = patch(json) ?? json;
  const payload = Buffer.from(JSON.stringify(next), 'utf8');
  const padded = Buffer.alloc(Math.ceil(payload.length / 4) * 4, 0x20);
  const binLength = Math.ceil(bin.length / 4) * 4;
  const out = Buffer.alloc(12 + 8 + padded.length + 8 + binLength);

  payload.copy(padded);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(out, 20);
  out.writeUInt32LE(binLength, 20 + padded.length);
  out.writeUInt32LE(0x004e4942, 24 + padded.length);
  Buffer.from(bin).copy(out, 28 + padded.length);

  return out;
}

test('GL-01 треугольники и вершины считаются с индексами и без', () => {
  const indexed = inspectGlb(makeGlb({ triangles: 12 }));
  const plain = inspectGlb(makeGlb({ triangles: 5, indexed: false }));

  assert.equal(indexed.triangles, 12);
  assert.equal(indexed.vertices, 36);
  assert.equal(plain.triangles, 5);
  assert.equal(plain.meshes, 1);
});

test('GL-02 кости без повторов и движения с длительностью', () => {
  const stats = inspectGlb(makeGlb({
    triangles: 2,
    joints: 41,
    animation: {
      name: 'walk',
      duration: 2.3667
    },
  }));

  assert.equal(stats.bones, 41);
  assert.deepEqual(stats.animations, [{
    name: 'walk',
    duration: 2.367
  }]);
});

test('GL-03 размер встроенной текстуры читается из заголовка PNG', () => {
  const stats = inspectGlb(makeGlb({
    image: {
      width: 512,
      height: 256
    }
  }));

  assert.deepEqual(stats.textures, [{
    format: 'png',
    width: 512,
    height: 256
  }]);
});

test('GL-04 габариты и направление взгляда фигуры в T-позе', () => {
  const wide = inspectGlb(makeGlb({
    triangles: 2,
    size: [1.983, 1.78, 0.394]
  }));

  assert.deepEqual(wide.size, [1.983, 1.78, 0.394]);
  assert.equal(wide.facing, 'z');
  assert.equal(facingOf([0.42, 1.8, 1.818]), 'x');
  assert.equal(facingOf([1, 1.8, 0.95]), null);
  assert.equal(facingOf(null), null);
});

test('GL-05 матрицы узлов меняют габариты: масштаб и поворот лицом к +X', () => {
  const scaled = inspectGlb(makeGlb({
    triangles: 2,
    size: [2, 1, 0.5],
    root: { scale: [2, 2, 2] }
  }));
  const turned = inspectGlb(makeGlb({
    triangles: 2,
    size: [2, 1, 0.5],
    root: { rotation: FACE_PLUS_X }
  }));

  assert.deepEqual(scaled.size, [4, 2, 1]);
  assert.deepEqual(turned.size, [0.5, 1, 2]);
  assert.equal(turned.facing, 'x');
});

test('GL-06 части — имена узлов с сеткой', () => {
  const stats = inspectGlb(makeGlb({ meshName: 'Дверь' }));

  assert.deepEqual(stats.parts, ['Дверь']);
});

test('GL-07 чужой и битый файл дают код ошибки', () => {
  const good = makeGlb();
  const wrongVersion = Buffer.from(good);
  const truncated = good.subarray(0, 30);

  wrongVersion.writeUInt32LE(1, 4);

  assert.throws(() => inspectGlb(Buffer.from('not a model at all, just text')), (error) => {
    return error instanceof GlbError && error.code === 'not_glb';
  });
  assert.throws(() => inspectGlb(wrongVersion), (error) => error.code === 'bad_glb');
  assert.throws(() => inspectGlb(truncated), (error) => error.code === 'bad_glb');
});

test('GL-08 обёртка поворачивает и масштабирует, не трогая данные', () => {
  const source = makeGlb({
    triangles: 4,
    size: [2, 1, 0.5],
    joints: 3,
    animation: {
      name: 'run',
      duration: 1.2
    },
  });
  const wrapped = wrapGlb(source, {
    rotation: FACE_PLUS_X,
    scale: 1.5
  });
  const before = parseGlb(source);
  const after = parseGlb(wrapped);
  const stats = inspectGlb(wrapped);
  const staticSource = patchJson(source, (json) => {
    delete json.animations;
  });
  const staticWrapped = wrapGlb(staticSource, {
    rotation: FACE_PLUS_X,
    scale: 1.5
  });

  assert.equal(wrapped.byteLength % 4, 0);
  assert.deepEqual(Buffer.from(after.bin), Buffer.from(before.bin));
  assert.equal(after.json.scenes[0].nodes.length, 1);
  assert.equal(after.json.nodes.at(-1).name, 'grigdesk-transform');
  assert.deepEqual(inspectGlb(staticWrapped).size, [0.75, 1.5, 3]);
  assert.equal(stats.size, null);
  assert.equal(stats.triangles, 4);
  assert.equal(stats.bones, 3);
  assert.equal(stats.animations[0].name, 'run');
});

test('GL-09 размер JPEG и WebP, незнакомый формат — null', () => {
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x01, 0x22, 0x00,
  ]);
  const webp = Buffer.alloc(32);

  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8X', 12, 'ascii');
  webp.writeUIntLE(1023, 24, 3);
  webp.writeUIntLE(511, 27, 3);

  assert.deepEqual(imageSize(jpeg), {
    format: 'jpeg',
    width: 512,
    height: 256
  });
  assert.deepEqual(imageSize(webp), {
    format: 'webp',
    width: 1024,
    height: 512
  });
  assert.equal(imageSize(Buffer.from('GIF89a........................')), null);
  assert.equal(imageSize(pngHeader(7, 9)).width, 7);
});

test('GL-10 точки и линии не дают треугольников, полоса — n − 2', () => {
  const points = inspectGlb(patchJson(makeGlb({ triangles: 3 }), (json) => {
    json.meshes[0].primitives[0].mode = 0;
  }));
  const strip = inspectGlb(patchJson(makeGlb({ triangles: 3 }), (json) => {
    json.meshes[0].primitives[0].mode = 5;
  }));

  assert.equal(points.triangles, 0);
  assert.equal(strip.triangles, 7);
});

test('FIX-04 GLB проверяет точную длину, границы, alignment и JSON первым', () => {
  const good = makeGlb();
  const cases = [];
  const largeChunk = Buffer.from(good);
  const wrongTotal = Buffer.from(good);
  const unaligned = Buffer.from(good);
  const wrongFirst = Buffer.from(good);

  largeChunk.writeUInt32LE(0xffffffff, 12);
  wrongTotal.writeUInt32LE(good.length - 4, 8);
  unaligned.writeUInt32LE(good.readUInt32LE(12) - 1, 12);
  wrongFirst.writeUInt32LE(0x004e4942, 16);
  cases.push(largeChunk, wrongTotal, unaligned, wrongFirst);

  for (const bytes of cases) {
    assert.throws(() => inspectGlb(bytes), (error) => error instanceof GlbError);
  }
});

test('FIX-04 типы массивов и индексы отвергаются типизированной ошибкой', () => {
  const patches = [
    (json) => {
      json.nodes = {};
    },
    (json) => {
      json.meshes = [null];
    },
    (json) => {
      json.nodes[0].mesh = 999;
    },
    (json) => {
      json.meshes[0].primitives[0].attributes.POSITION = -1;
    },
    (json) => {
      json.nodes[0].translation = [0, 'ошибка', 1];
    },
  ];

  for (const patch of patches) {
    const bytes = patchJson(makeGlb(), patch);

    assert.throws(() => inspectGlb(bytes), (error) => error instanceof GlbError);
  }
});

test('FIX-04 цикл, общий child и чрезмерная глубина не обходятся рекурсивно', () => {
  const graphs = [
    [{ children: [0] }],
    [{ children: [1, 1] }, {}],
    [{ children: [2] }, { children: [2] }, {}],
    Array.from({ length: 258 }, (_, index) => {
      return index === 257 ? {} : { children: [index + 1] };
    }),
  ];

  for (const nodes of graphs) {
    const bytes = patchJson(makeGlb(), (json) => {
      json.nodes = nodes;
      json.scenes = [{ nodes: [0] }];
    });

    assert.throws(() => inspectGlb(bytes), (error) => error instanceof GlbError);
  }
});

test('FIX-04 количество узлов ограничено до обхода графа', () => {
  const bytes = patchJson(makeGlb(), (json) => {
    json.nodes = Array.from({ length: 100001 }, () => ({}));
  });

  assert.throws(() => inspectGlb(bytes), (error) => error instanceof GlbError);
});

test('FIX-04 экземпляры одной сетки считаются, неполные bounds не задают рост', () => {
  const instanced = patchJson(makeGlb({ triangles: 4 }), (json) => {
    json.nodes.push({ mesh: 0, translation: [2, 0, 0] });
    json.scenes[0].nodes.push(1);
  });
  const incomplete = patchJson(instanced, (json) => {
    delete json.accessors[0].max;
  });
  const animated = makeGlb({
    triangles: 4,
    animation: { name: 'Ходьба', duration: 2 }
  });
  const skinned = patchJson(makeGlb({ joints: 2 }), (json) => {
    json.nodes[0].skin = 0;
  });

  assert.equal(inspectGlb(instanced).triangles, 8);
  assert.equal(inspectGlb(incomplete).size, null);
  assert.equal(inspectGlb(animated).size, null);
  assert.equal(inspectGlb(skinned).size, null);
});
