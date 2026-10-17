// Сборщик маленьких настоящих GLB для тестов раздела «3D»: сетка из N треугольников,
// по желанию скелет, движение, встроенная картинка и свои узлы. Файл валиден по
// спецификации — его читает и сводка сервера, и загрузчик three.js в тестах веба.

const GLB_MAGIC = 0x46546c67;

/**
 * Склеивает чанк GLB с выравниванием до четырёх байт.
 * JSON добивается пробелами, бинарные данные — нулями.
 */
function chunk(type, payload, pad) {
  const length = Math.ceil(payload.length / 4) * 4;
  const out = Buffer.alloc(8 + length, pad);

  out.writeUInt32LE(length, 0);
  out.writeUInt32LE(type, 4);
  payload.copy(out, 8);

  return out;
}

/**
 * Заголовок PNG с чанком IHDR: сводке нужны только ширина и высота.
 * Остальные байты картинки сводка не читает.
 */
export function pngHeader(width, height) {
  const out = Buffer.alloc(33);

  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out, 0);
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'ascii');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);

  return out;
}

/**
 * Собирает GLB по описанию. triangles — число треугольников; size — габариты
 * [x, y, z] коробки сетки; joints — число костей цепочкой; animation —
 * { name, duration }; image — { width, height }; root — поля корневого узла.
 */
export function makeGlb({
  triangles = 1,
  indexed = true,
  size = [1, 1, 1],
  joints = 0,
  animation = null,
  image = null,
  root = {},
  meshName = 'Тело',
  extensionsUsed = [],
} = {}) {
  const positions = Buffer.alloc(triangles * 3 * 12);
  const [sx, sy, sz] = size;

  for (let index = 0; index < triangles; index += 1) {
    const base = index * 36;
    const z = triangles > 1 ? (index / (triangles - 1)) * sz : 0;

    positions.writeFloatLE(0, base);
    positions.writeFloatLE(0, base + 4);
    positions.writeFloatLE(z, base + 8);
    positions.writeFloatLE(sx, base + 12);
    positions.writeFloatLE(0, base + 16);
    positions.writeFloatLE(z, base + 20);
    positions.writeFloatLE(0, base + 24);
    positions.writeFloatLE(sy, base + 28);
    positions.writeFloatLE(z, base + 32);
  }

  const parts = [positions];
  const bufferViews = [{
    buffer: 0,
    byteOffset: 0,
    byteLength: positions.length
  }];
  const accessors = [{
    bufferView: 0,
    componentType: 5126,
    count: triangles * 3,
    type: 'VEC3',
    min: [0, 0, 0],
    max: [sx, sy, triangles > 1 ? sz : 0],
  }];
  const primitive = { attributes: { POSITION: 0 } };

  /**
   * Дописывает кусок бинарных данных и возвращает номер его bufferView.
   * Смещение выравнивается до четырёх байт, как требует glTF для аксессоров.
   */
  const pushView = (bytes) => {
    const used = parts.reduce((sum, part) => sum + part.length, 0);
    const padding = Buffer.alloc((4 - (used % 4)) % 4);

    parts.push(padding, bytes);
    bufferViews.push({
      buffer: 0,
      byteOffset: used + padding.length,
      byteLength: bytes.length
    });

    return bufferViews.length - 1;
  };

  if (indexed) {
    const indices = Buffer.alloc(triangles * 3 * 4);

    for (let index = 0; index < triangles * 3; index += 1) {
      indices.writeUInt32LE(index, index * 4);
    }

    accessors.push({
      bufferView: pushView(indices),
      componentType: 5125,
      count: triangles * 3,
      type: 'SCALAR'
    });
    primitive.indices = accessors.length - 1;
  }

  const nodes = [{ name: meshName, mesh: 0 }];
  const json = {
    asset: { version: '2.0', generator: 'cockpit-tests' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{ name: meshName, primitives: [primitive] }],
    accessors,
    bufferViews,
    buffers: [],
  };

  if (joints > 0) {
    const first = nodes.length;

    for (let index = 0; index < joints; index += 1) {
      const joint = { name: `Кость ${index + 1}` };

      if (index + 1 < joints) {
        joint.children = [first + index + 1];
      }

      nodes.push(joint);
    }

    json.skins = [{ joints: nodes.slice(first).map((_, index) => first + index) }];
    json.scenes[0].nodes.push(first);
  }

  if (animation) {
    const times = Buffer.alloc(8);

    times.writeFloatLE(0, 0);
    times.writeFloatLE(animation.duration, 4);
    accessors.push({
      bufferView: pushView(times),
      componentType: 5126,
      count: 2,
      type: 'SCALAR',
      min: [0],
      max: [animation.duration],
    });

    const values = Buffer.alloc(24);

    accessors.push({
      bufferView: pushView(values),
      componentType: 5126,
      count: 2,
      type: 'VEC3'
    });
    json.animations = [{
      name: animation.name,
      samplers: [{ input: accessors.length - 2, output: accessors.length - 1 }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
    }];
  }

  if (image) {
    json.images = [{ bufferView: pushView(pngHeader(image.width, image.height)), mimeType: 'image/png' }];
  }

  if (extensionsUsed.length > 0) {
    json.extensionsUsed = extensionsUsed;
  }

  Object.assign(nodes[0], root);

  const bin = Buffer.concat(parts);

  json.buffers = [{ byteLength: bin.length }];

  const jsonChunk = chunk(0x4e4f534a, Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = chunk(0x004e4942, bin, 0);
  const header = Buffer.alloc(12);

  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8);

  return Buffer.concat([header, jsonChunk, binChunk]);
}

/**
 * Маленький PNG содержит реальные pixels, CRC и zlib stream, в отличие от pngHeader.
 * Используется для проверок полного decode при сохранении результата исполнителя.
 */
export async function pngImage(width = 3, height = 3) {
  const { deflateSync } = await import('node:zlib');
  const header = Buffer.alloc(13);
  const pixels = Buffer.alloc(height * (width * 4 + 1), 180);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  for (let row = 0; row < height; row += 1) {
    pixels[row * (width * 4 + 1)] = 0;
  }

  /**
   * Длина и checksum относятся к точному body chunk, padding отсутствует.
   * Декодер не получает разрешение игнорировать повреждённую фикстуру.
   */
  const pngChunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;

    for (const byte of body) {
      crc ^= byte;

      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }

    const chunk = Buffer.alloc(data.length + 12);

    chunk.writeUInt32BE(data.length, 0);
    body.copy(chunk, 4);
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);

    return chunk;
  };

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
