import { MeshoptEncoder } from '../../../web/node_modules/meshoptimizer/meshopt_encoder.js';

import { deflateSync } from 'node:zlib';

/**
 * PNG fixture имеет корректные CRC и zlib stream для строгого Chromium decoder.
 * Проверяется реальная растровая текстура, а не заголовок с выдуманными пикселями.
 */
function makeTexture() {
  /**
   * CRC вычисляется над типом и телом каждого chunk, как требует PNG.
   * Фикстура годится для строгого image decoder без игнорирования ошибок.
   */
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    const body = Buffer.concat([type, data]);
    let crc = 0xffffffff;

    for (const byte of body) {
      crc ^= byte;

      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }

    const result = Buffer.alloc(data.length + 12);

    result.writeUInt32BE(data.length, 0);
    body.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);

    return result;
  };
  const header = Buffer.alloc(13);

  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([
      0, 255, 220, 20, 255, 20, 100, 255, 255,
      0, 20, 100, 255, 255, 255, 220, 20, 255,
    ]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const texturePng = makeTexture();

/**
 * Синтетическая сцена имеет две части и настоящий skin с анимацией кости.
 * Все buffers создаются локально; fixture не использует файлы пользователя или сеть.
 */
export function sceneFixture() {
  const chunks = [];
  const views = [];
  const accessors = [];
  let offset = 0;
  /**
   * Buffer views начинаются на четырёхбайтной границе независимо от типа accessor.
   * Длина accessor отражает исходные элементы, padding не превращается в geometry.
   */
  const add = (array, type, componentType, extra = {}) => {
    const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);

    data.copy(padded);
    views.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: data.length
    });
    chunks.push(padded);
    offset += padded.length;
    accessors.push({
      bufferView: views.length - 1,
      componentType,
      count: array.length / {
        VEC2: 2,
        VEC3: 3,
        VEC4: 4,
        SCALAR: 1
      }[type],
      type,
      ...extra,
    });

    return accessors.length - 1;
  };
  const positions = add(new Float32Array([
    -0.8, -1, -0.5, 0.8, -1, -0.5, 0.8, 1, -0.5, -0.8, 1, -0.5,
    -0.8, -1, 0.5, 0.8, -1, 0.5, 0.8, 1, 0.5, -0.8, 1, 0.5,
  ]), 'VEC3', 5126, { min: [-0.8, -1, -0.5], max: [0.8, 1, 0.5] });
  const indices = add(new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]), 'SCALAR', 5123);
  const joints = add(new Uint16Array(32), 'VEC4', 5123);
  const weightsArray = new Float32Array(32);

  for (let index = 0; index < 8; index += 1) {
    weightsArray[index * 4] = 1;
  }

  const weights = add(weightsArray, 'VEC4', 5126);
  const uv = add(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]), 'VEC2', 5126);
  const times = add(new Float32Array([0, 2]), 'SCALAR', 5126, { min: [0], max: [2] });
  const rotations = add(new Float32Array([0, 0, 0, 1, 0, 0, Math.sin(0.65), Math.cos(0.65)]), 'VEC4', 5126);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [
      {
        name: 'Тело',
        mesh: 0,
        skin: 0
      },
      {
        name: 'Основание',
        mesh: 1,
        translation: [-2, -0.8, 0],
        scale: [0.4, 0.4, 0.4]
      },
      { name: 'Кость' },
    ],
    skins: [{ joints: [2] }],
    meshes: [
      { primitives: [{
        attributes: {
          POSITION: positions,
          JOINTS_0: joints,
          WEIGHTS_0: weights,
          TEXCOORD_0: uv
        },
        indices,
        material: 0
      }] },
      { primitives: [{
        attributes: { POSITION: positions },
        indices,
        material: 1
      }] },
    ],
    materials: [
      { pbrMetallicRoughness: {
        baseColorFactor: [0.9, 0.25, 0.1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.8
      } },
      { pbrMetallicRoughness: {
        baseColorFactor: [0.1, 0.7, 0.8, 1],
        metallicFactor: 0,
        roughnessFactor: 0.8
      } },
    ],
    animations: [{
      name: 'Поворот кости',
      samplers: [{ input: times, output: rotations }],
      channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }],
    }],
    buffers: [{ byteLength: offset }],
    bufferViews: views,
    accessors,
  };

  return { json, binary: Buffer.concat(chunks) };
}

/**
 * GLB содержит точные длины двух выровненных chunks.
 * Входной JSON можно менять для негативных тестов без стороннего генератора.
 */
export function packGlb({ json, binary }) {
  const text = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  const binChunk = Buffer.alloc(Math.ceil(binary.length / 4) * 4);

  text.copy(jsonChunk);
  binary.copy(binChunk);

  const result = Buffer.alloc(28 + jsonChunk.length + binChunk.length);

  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonChunk.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(result, 20);
  result.writeUInt32LE(binChunk.length, 20 + jsonChunk.length);
  result.writeUInt32LE(0x004e4942, 24 + jsonChunk.length);
  binChunk.copy(result, 28 + jsonChunk.length);

  return result;
}

/**
 * Meshopt кодирует реальные positions, а не только объявляет расширение в JSON.
 * Загрузчик обязан декодировать эти bytes, чтобы тест получил непустую geometry.
 */
export async function meshoptFixture() {
  await MeshoptEncoder.ready;

  const fixture = sceneFixture();
  const view = fixture.json.bufferViews[0];
  const source = fixture.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength);
  const encoded = MeshoptEncoder.encodeGltfBuffer(source, 8, 12, 'ATTRIBUTES');
  const offset = fixture.binary.length;

  fixture.binary = Buffer.concat([fixture.binary, Buffer.from(encoded)]);
  fixture.json.buffers[0].byteLength = fixture.binary.length;
  fixture.json.extensionsUsed = ['EXT_meshopt_compression'];
  view.extensions = { EXT_meshopt_compression: {
    buffer: 0,
    byteOffset: offset,
    byteLength: encoded.length,
    byteStride: 12,
    count: 8,
    mode: 'ATTRIBUTES',
    filter: 'NONE',
  } };

  return packGlb(fixture);
}

/**
 * ASCII FBX имеет geometry, model и связь между ними в формате официального addon.
 * Табуляции сохраняют вложенность TextParser; fixture не зависит от FBX exporter.
 */
export function fbxFixture() {
  return Buffer.from([
    '; FBX 7.4.0 project file',
    'FBXHeaderExtension:  {', '\tFBXVersion: 7400', '}',
    'Objects:  {',
    '\tGeometry: 1, "Geometry::Треугольник", "Mesh" {',
    '\t\tVertices: *9 {', '\t\t\ta: 0,0,0,1,0,0,0,1,0', '\t\t}',
    '\t\tPolygonVertexIndex: *3 {', '\t\t\ta: 0,1,-3', '\t\t}', '\t}',
    '\tModel: 2, "Model::Треугольник", "Mesh" {', '\t\tVersion: 232', '\t}', '}',
    'Connections:  {', '\tC: "OO",1,2', '\tC: "OO",2,0', '}',
  ].join('\n'));
}

/**
 * Splat fixture задаёт небольшое цветное облако с полными 32-byte records.
 * Масштаб и quaternion присутствуют даже при ограниченном point preview.
 */
export function splatFixture() {
  const bytes = Buffer.alloc(32 * 80);

  for (let index = 0; index < 80; index += 1) {
    const offset = index * 32;

    bytes.writeFloatLE(Math.cos(index) * 0.8, offset);
    bytes.writeFloatLE(index / 40 - 1, offset + 4);
    bytes.writeFloatLE(Math.sin(index) * 0.8, offset + 8);

    for (let axis = 0; axis < 3; axis += 1) {
      bytes.writeFloatLE(0.03, offset + 12 + axis * 4);
    }

    bytes.set([240, 100 + index, 80, 255, 255, 128, 128, 128], offset + 24);
  }

  return bytes;
}
