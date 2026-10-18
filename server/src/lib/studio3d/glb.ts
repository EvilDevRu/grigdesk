// Сводка и разворот GLB без сторонних библиотек. Читается только JSON-чанк и заголовки
// картинок: геометрия не декодируется, поэтому сжатые сетки и модели на 140 МБ
// разбираются за десятки миллисекунд. Разворот добавляет новый корневой узел и не
// трогает бинарный чанк.

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const GLB_MAX_BYTES = 150 * 1024 * 1024;
export const GLB_JSON_MAX_BYTES = 16 * 1024 * 1024;
export const GLB_MAX_NODES = 100_000;
export const GLB_MAX_DEPTH = 256;

// Поворот модели, смотрящей вперёд по +Z (соглашение glTF), лицом к +X: +90° вокруг Y.
export const FACE_PLUS_X: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

// Обратный поворот: модель, смотрящая по +X, разворачивается лицом к +Z.
export const FACE_PLUS_Z: Quaternion = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];

export type Quaternion = [number, number, number, number];

export interface TextureInfo {
  format: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
}

export interface AnimationInfo {
  name: string;
  duration: number;
}

export interface GlbStats {
  triangles: number;
  vertices: number;
  meshes: number;
  materials: number;
  bones: number;
  animations: AnimationInfo[];
  textures: (TextureInfo | null)[];
  size: [number, number, number] | null;
  facing: 'x' | 'z' | null;
  parts: string[];
  extensions: string[];
}

export interface WrapOptions {
  rotation?: Quaternion;
  scale?: number;
  name?: string;
}

export class GlbError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

interface GltfAccessor {
  count: number;
  min?: number[];
  max?: number[];
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
}

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  skin?: number;
}

interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  accessors?: GltfAccessor[];
  materials?: unknown[];
  skins?: { joints: number[] }[];
  animations?: { name?: string; samplers: { input: number }[] }[];
  images?: { bufferView?: number }[];
  bufferViews?: { byteOffset?: number; byteLength: number }[];
  buffers?: { byteLength: number }[];
  extensionsUsed?: string[];
  [field: string]: unknown;
}

/**
 * Делит GLB на JSON и бинарный чанк, проверяя магию, версию и длины.
 * Битый или чужой файл даёт GlbError с кодом, а не исключение разбора.
 */
export function parseGlb(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new GlbError('not_glb');
  }

  const total = view.getUint32(8, true);

  if (bytes.byteLength > GLB_MAX_BYTES) {
    throw new GlbError('too_large');
  }

  if (view.getUint32(4, true) !== 2 || total !== bytes.byteLength || total % 4 !== 0) {
    throw new GlbError('bad_glb');
  }

  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;

  while (offset < total) {
    if (offset + 8 > total) {
      throw new GlbError('bad_chunk');
    }

    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);

    if (length % 4 !== 0 || offset + 8 + length > total || (offset === 12 && type !== CHUNK_JSON)) {
      throw new GlbError('bad_chunk');
    }

    const data = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === CHUNK_JSON) {
      if (json || length > GLB_JSON_MAX_BYTES) {
        throw new GlbError(length > GLB_JSON_MAX_BYTES ? 'json_too_large' : 'bad_chunk');
      }

      json = readJson(data);
    } else if (type === CHUNK_BIN) {
      if (bin) {
        throw new GlbError('bad_chunk');
      }

      bin = data;
    }

    offset += 8 + length;
  }

  if (!json) {
    throw new GlbError('bad_glb');
  }

  validateJson(json, bin?.byteLength ?? 0);

  return {
    json,
    bin
  };
}

/**
 * Объект glTF обязан быть обычным JSON-объектом. Проверка стоит перед чтением полей,
 * чтобы повреждённые массивы давали GlbError вместо случайного TypeError.
 */
function requireObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GlbError('bad_schema');
  }
}

/**
 * Индекс подтверждается по конкретному массиву, включая целочисленность и диапазон.
 * Такое правило применяется также к неиспользуемым сценой данным повреждённого файла.
 */
function requireIndex(value: unknown, length: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length) {
    throw new GlbError('bad_index');
  }
}

/**
 * Вектор/TRS содержит только конечные числа с заданной длиной. Неизвестные габариты
 * допускаются отсутствующим min/max, но повреждённые bounds не участвуют в масштабе.
 */
function requireVector(value: unknown, length: number): void {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    throw new GlbError('bad_vector');
  }
}

/**
 * Проверяет используемые сводкой массивы и ссылки до обхода. Binary остаётся сжатым:
 * meshopt не требует распаковки для индексов, числа граней и bounds из JSON.
 */
function validateJson(json: GltfJson, binarySize: number): void {
  const arrays = [
    'nodes', 'scenes', 'meshes', 'accessors', 'materials', 'skins',
    'animations', 'images', 'bufferViews', 'buffers', 'extensionsUsed',
  ];

  for (const key of arrays) {
    if (json[key] !== undefined && !Array.isArray(json[key])) {
      throw new GlbError('bad_schema');
    }
  }

  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const accessors = json.accessors ?? [];
  const views = json.bufferViews ?? [];

  if (nodes.length > GLB_MAX_NODES) {
    throw new GlbError('nodes_limit');
  }

  for (const accessor of accessors) {
    requireObject(accessor);

    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0) {
      throw new GlbError('bad_accessor');
    }

    for (const key of ['min', 'max'] as const) {
      if (accessor[key] !== undefined) {
        const vector = accessor[key];

        if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) {
          throw new GlbError('bad_accessor');
        }
      }
    }
  }

  for (const mesh of meshes) {
    requireObject(mesh);

    if (!Array.isArray(mesh.primitives)) {
      throw new GlbError('bad_mesh');
    }

    for (const primitive of mesh.primitives) {
      requireObject(primitive);
      requireObject(primitive.attributes);

      for (const index of Object.values(primitive.attributes)) {
        requireIndex(index, accessors.length);
      }

      if (primitive.indices !== undefined) {
        requireIndex(primitive.indices, accessors.length);
      }

      if (primitive.mode !== undefined && (!Number.isInteger(primitive.mode) || primitive.mode < 0
        || primitive.mode > 6)) {
        throw new GlbError('bad_primitive');
      }

      const position = accessors[primitive.attributes.POSITION ?? -1];

      if (position?.min !== undefined) {
        requireVector(position.min, 3);
      }

      if (position?.max !== undefined) {
        requireVector(position.max, 3);
      }
    }
  }

  for (const node of nodes) {
    requireObject(node);

    if (node.mesh !== undefined) {
      requireIndex(node.mesh, meshes.length);
    }

    if (node.skin !== undefined) {
      requireIndex(node.skin, (json.skins ?? []).length);
    }

    const vectors = [['matrix', 16], ['translation', 3], ['rotation', 4], ['scale', 3]] as const;

    for (const [key, length] of vectors) {
      if (node[key] !== undefined) {
        requireVector(node[key], length);
      }
    }
  }

  validateGraph(json);

  for (const skin of json.skins ?? []) {
    requireObject(skin);

    if (!Array.isArray(skin.joints)) {
      throw new GlbError('bad_skin');
    }

    for (const index of skin.joints) {
      requireIndex(index, nodes.length);
    }
  }

  for (const animation of json.animations ?? []) {
    requireObject(animation);

    if (!Array.isArray(animation.samplers)) {
      throw new GlbError('bad_animation');
    }

    for (const sampler of animation.samplers) {
      requireObject(sampler);
      requireIndex(sampler.input, accessors.length);
    }
  }

  for (const view of views) {
    requireObject(view);

    const offset = view.byteOffset ?? 0;

    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(view.byteLength)
      || view.byteLength < 0) {
      throw new GlbError('bad_buffer_view');
    }
  }

  for (const image of json.images ?? []) {
    requireObject(image);

    if (image.bufferView !== undefined) {
      requireIndex(image.bufferView, views.length);

      const view = views[image.bufferView]!;

      if ((view.byteOffset ?? 0) + view.byteLength > binarySize) {
        throw new GlbError('bad_image');
      }
    }
  }

  validateLinks(json);
}

/**
 * Остальные ссылки glTF также проверяются по собственным массивам. Это не декодер
 * геометрии: сжатые bufferView остаются допустимыми и не распаковываются здесь.
 */
function validateLinks(json: GltfJson): void {
  const arrays: Record<string, unknown[]> = {
    bufferView: json.bufferViews ?? [],
    buffer: json.buffers ?? [],
    material: json.materials ?? [],
    inverseBindMatrices: json.accessors ?? [],
    skeleton: json.nodes ?? [],
    output: json.accessors ?? [],
  };
  const groups: [unknown[], string[]][] = [
    [json.accessors ?? [], ['bufferView']],
    [json.bufferViews ?? [], ['buffer']],
    [json.skins ?? [], ['inverseBindMatrices', 'skeleton']],
    [(json.meshes ?? []).flatMap((mesh) => mesh.primitives), ['material']],
    [(json.animations ?? []).flatMap((animation) => animation.samplers), ['output']],
  ];

  for (const [entries, fields] of groups) {
    for (const raw of entries) {
      requireObject(raw);

      for (const field of fields) {
        if (raw[field] !== undefined) {
          requireIndex(raw[field], arrays[field]!.length);
        }
      }
    }
  }

  for (const animation of json.animations ?? []) {
    const channels = (animation as unknown as Record<string, unknown>).channels;

    if (channels === undefined) {
      continue;
    }

    if (!Array.isArray(channels)) {
      throw new GlbError('bad_animation');
    }

    for (const channel of channels) {
      requireObject(channel);
      requireIndex(channel.sampler, animation.samplers.length);
      requireObject(channel.target);

      if (channel.target.node !== undefined) {
        requireIndex(channel.target.node, (json.nodes ?? []).length);
      }
    }
  }
}

/**
 * Проверяет лес за линейное время: один родитель, уникальные дети, глубина до 256.
 * Необойдённые после корней узлы означают цикл, включая невыбранные сцены.
 */
function validateGraph(json: GltfJson): void {
  const nodes = json.nodes ?? [];
  const parents = new Int32Array(nodes.length).fill(-1);

  for (let index = 0; index < nodes.length; index += 1) {
    const children = nodes[index]?.children ?? [];

    if (!Array.isArray(children)) {
      throw new GlbError('bad_children');
    }

    for (const child of children) {
      requireIndex(child, nodes.length);

      if (parents[child] !== -1) {
        throw new GlbError('multiple_parents');
      }

      parents[child] = index;
    }
  }

  const stack = nodes.flatMap((_, index) => parents[index] === -1 ? [{ index, depth: 1 }] : []);
  let visited = 0;

  while (stack.length) {
    const current = stack.pop()!;

    if (current.depth > GLB_MAX_DEPTH) {
      throw new GlbError('depth_limit');
    }

    visited += 1;

    for (const child of nodes[current.index]?.children ?? []) {
      stack.push({ index: child, depth: current.depth + 1 });
    }
  }

  if (visited !== nodes.length) {
    throw new GlbError('cycle');
  }

  if (json.scene !== undefined) {
    requireIndex(json.scene, (json.scenes ?? []).length);
  }

  for (const scene of json.scenes ?? []) {
    requireObject(scene);

    const roots = scene.nodes ?? [];
    const unique = new Set<number>();

    if (!Array.isArray(roots)) {
      throw new GlbError('bad_scene');
    }

    for (const root of roots) {
      requireIndex(root, nodes.length);

      if (parents[root] !== -1 || unique.has(root)) {
        throw new GlbError('bad_scene');
      }

      unique.add(root);
    }
  }
}

/**
 * Разбирает JSON-чанк и отбрасывает всё, что не объект верхнего уровня.
 * Ошибка разбора превращается в общий код битого файла.
 */
function readJson(data: Uint8Array): GltfJson {
  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new GlbError('bad_glb');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GlbError('bad_glb');
  }

  return parsed as GltfJson;
}

/**
 * Перемножает матрицы 4×4 в порядке glTF (столбцы подряд): результат = a · b.
 * Нужна только для габаритов, поэтому точности double хватает.
 */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);

  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;

      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      }

      out[column * 4 + row] = sum;
    }
  }

  return out;
}

/**
 * Собирает локальную матрицу узла из matrix либо из сдвига, поворота и масштаба.
 * Отсутствующие поля — тождественные значения по спецификации glTF.
 */
function nodeMatrix(node: GltfNode): number[] {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return node.matrix;
  }

  const [tx = 0, ty = 0, tz = 0] = node.translation ?? [];
  const [x = 0, y = 0, z = 0, w = 1] = node.rotation ?? [];
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? [];

  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

// Переводит точку матрицей мира; четвёртая координата не нужна — проекций нет.
function transform(m: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/**
 * Узнаёт формат и размер встроенной картинки по заголовку PNG, JPEG или WebP.
 * Незнакомый формат даёт null: сводка не обещает того, чего не прочитала.
 */
export function imageSize(bytes: Uint8Array): TextureInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

  if (bytes.byteLength > 24 && view.getUint32(0) === 0x89504e47) {
    return {
      format: 'png',
      width: view.getUint32(16),
      height: view.getUint32(20)
    };
  }

  if (bytes.byteLength > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(bytes, view);
  }

  if (bytes.byteLength > 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return webpSize(bytes, view, ascii(12, 16));
  }

  return null;
}

/**
 * Ищет маркер SOF в JPEG: там записаны высота и ширина кадра.
 * Маркеры DHT, JPG и DAC пропускаются — их номера лежат внутри диапазона SOF.
 */
function jpegSize(bytes: Uint8Array, view: DataView): TextureInfo | null {
  let index = 2;

  while (index + 9 < bytes.byteLength) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }

    const marker = bytes[index + 1] ?? 0;
    const length = view.getUint16(index + 2);

    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        format: 'jpeg',
        width: view.getUint16(index + 7),
        height: view.getUint16(index + 5)
      };
    }

    index += 2 + length;
  }

  return null;
}

/**
 * Читает размер из трёх вариантов WebP: VP8X, VP8L (без потерь) и VP8 (с потерями).
 * Поля разной разрядности, поэтому у каждого варианта своя ветка.
 */
function webpSize(bytes: Uint8Array, view: DataView, kind: string): TextureInfo | null {
  const uint24 = (at: number) => {
    return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
  };

  if (kind === 'VP8X') {
    return {
      format: 'webp',
      width: 1 + uint24(24),
      height: 1 + uint24(27)
    };
  }

  if (kind === 'VP8L') {
    const bits = view.getUint32(21, true);

    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  if (kind === 'VP8 ') {
    return {
      format: 'webp',
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff
    };
  }

  return null;
}

/**
 * Считает сводку модели: треугольники с учётом экземпляров узлов, кости, движения,
 * габариты сцены, текстуры и имена частей. Габариты берутся из обязательных min/max
 * атрибута POSITION, переведённых матрицами мира.
 */
export function inspectGlb(bytes: Uint8Array): GlbStats {
  const { json, bin } = parseGlb(bytes);
  const accessors = json.accessors ?? [];
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const scene = json.scenes?.[json.scene ?? 0];
  const childNodes = new Set(nodes.flatMap((node) => node.children ?? []));
  const roots = scene?.nodes ?? nodes.flatMap((_, index) => childNodes.has(index) ? [] : [index]);
  const totals = {
    triangles: 0,
    vertices: 0
  };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const parts: string[] = [];
  const stack = roots.map((index) => ({ index, parent: IDENTITY }));
  let reliableBounds = (json.animations ?? []).length === 0;

  while (stack.length) {
    const { index, parent } = stack.pop()!;
    const node = nodes[index];

    if (!node) {
      throw new GlbError('bad_index');
    }

    const world = multiply(parent, nodeMatrix(node));
    const mesh = node.mesh === undefined ? undefined : meshes[node.mesh];

    if (node.skin !== undefined) {
      reliableBounds = false;
    }

    if (mesh) {
      parts.push(node.name || mesh.name || `Часть ${parts.length + 1}`);

      for (const primitive of mesh.primitives ?? []) {
        countPrimitive(primitive, accessors, world, totals, min, max);

        const position = accessors[primitive.attributes.POSITION ?? -1];

        if (!position?.min || !position.max
          || position.min.some((value, axis) => value > position.max![axis]!)) {
          reliableBounds = false;
        }
      }
    }

    for (const child of node.children ?? []) {
      stack.push({ index: child, parent: world });
    }
  }

  const size = reliableBounds && min.every(Number.isFinite) && max.every(Number.isFinite)
    ? max.map((value, axis) => round(value - (min[axis] ?? 0))) as [number, number, number]
    : null;

  return {
    triangles: Math.round(totals.triangles),
    vertices: totals.vertices,
    meshes: meshes.length,
    materials: (json.materials ?? []).length,
    bones: countBones(json),
    animations: readAnimations(json, accessors),
    textures: readTextures(json, bin),
    size,
    facing: facingOf(size),
    parts,
    extensions: Array.isArray(json.extensionsUsed) ? json.extensionsUsed.map(String) : [],
  };
}

/**
 * Добавляет к итогам один примитив: треугольники по режиму отрисовки и углы его коробки.
 * Точки и линии треугольников не дают; полосы и веера — по формуле n − 2.
 */
function countPrimitive(
  primitive: GltfPrimitive,
  accessors: GltfAccessor[],
  world: number[],
  totals: { triangles: number; vertices: number },
  min: [number, number, number],
  max: [number, number, number],
) {
  const position = accessors[primitive.attributes?.POSITION ?? -1];

  if (!position) {
    return;
  }

  const mode = primitive.mode ?? 4;
  const indexed = primitive.indices === undefined ? undefined : accessors[primitive.indices];
  const count = indexed ? indexed.count : position.count;

  if (mode === 4) {
    totals.triangles += count / 3;
  } else if (mode === 5 || mode === 6) {
    totals.triangles += Math.max(0, count - 2);
  }

  totals.vertices += position.count;

  if (!position.min || !position.max) {
    return;
  }

  for (const x of [position.min[0] ?? 0, position.max[0] ?? 0]) {
    for (const y of [position.min[1] ?? 0, position.max[1] ?? 0]) {
      for (const z of [position.min[2] ?? 0, position.max[2] ?? 0]) {
        const point = transform(world, x, y, z);

        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis] ?? Infinity, point[axis] ?? 0);
          max[axis] = Math.max(max[axis] ?? -Infinity, point[axis] ?? 0);
        }
      }
    }
  }
}

/**
 * Кости считаются без повторов: один сустав может входить в несколько скинов.
 * Число нужно сводке и выбору следующего шага «Движения».
 */
function countBones(json: GltfJson): number {
  const joints = new Set<number>();

  for (const skin of json.skins ?? []) {
    for (const joint of skin.joints ?? []) {
      joints.add(joint);
    }
  }

  return joints.size;
}

/**
 * Длительность движения — наибольший max входных времён его семплеров.
 * Спецификация требует min/max у этих аксессоров, так что данные не декодируются.
 */
function readAnimations(json: GltfJson, accessors: GltfAccessor[]): AnimationInfo[] {
  return (json.animations ?? []).map((animation) => {
    let duration = 0;

    for (const sampler of animation.samplers ?? []) {
      duration = Math.max(duration, accessors[sampler.input]?.max?.[0] ?? 0);
    }

    return {
      name: animation.name || '',
      duration: round(duration)
    };
  });
}

// Встроенные картинки читаются по bufferView; картинка по внешней ссылке даёт null.
function readTextures(json: GltfJson, bin: Uint8Array | null): (TextureInfo | null)[] {
  return (json.images ?? []).map((image) => {
    const view = image.bufferView === undefined ? undefined : json.bufferViews?.[image.bufferView];

    if (!view || !bin) {
      return null;
    }

    const start = view.byteOffset ?? 0;

    return imageSize(bin.subarray(start, start + view.byteLength));
  });
}

/**
 * Угадывает, куда смотрит фигура в T-позе: размах рук — большая горизонтальная сторона,
 * взгляд — вдоль другой. Почти квадратная коробка ответа не даёт.
 */
export function facingOf(size: [number, number, number] | null): 'x' | 'z' | null {
  if (!size) {
    return null;
  }

  const [x, , z] = size;
  const wider = Math.max(x, z);

  if (wider <= 0 || Math.abs(x - z) / wider < 0.15) {
    return null;
  }

  return x > z ? 'z' : 'x';
}

// Три знака после запятой: миллиметры для метровой сцены.
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Склеивает чанк GLB: длина, тип и данные, выровненные до четырёх байт.
 * JSON добивается пробелами, бинарный чанк — нулями, как требует формат.
 */
function chunk(type: number, payload: Uint8Array, pad: number): Uint8Array {
  const length = Math.ceil(payload.byteLength / 4) * 4;
  const out = new Uint8Array(8 + length).fill(pad, 8);
  const view = new DataView(out.buffer);

  view.setUint32(0, length, true);
  view.setUint32(4, type, true);
  out.set(payload, 8);

  return out;
}

/**
 * Разворачивает и масштабирует модель новым корневым узлом над корнями сцены.
 * Скелет и движения поворачиваются вместе с сеткой: суставы — потомки нового узла.
 */
export function wrapGlb(bytes: Uint8Array, options: WrapOptions): Uint8Array {
  const { json, bin } = parseGlb(bytes);

  if (options.rotation !== undefined) {
    requireVector(options.rotation, 4);
  }

  if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale <= 0)) {
    throw new GlbError('bad_scale');
  }

  const sceneIndex = json.scene ?? 0;
  const children = new Set((json.nodes ?? []).flatMap((node) => node.children ?? []));
  const roots = (json.nodes ?? []).flatMap((_, index) => children.has(index) ? [] : [index]);
  const scenes = json.scenes ?? [{ nodes: roots }];
  const scene = scenes[sceneIndex];

  if (!scene) {
    throw new GlbError('bad_glb');
  }

  const root: GltfNode = {
    name: options.name ?? 'grigdesk-transform',
    children: [...(scene.nodes ?? [])]
  };

  if (options.rotation) {
    root.rotation = [...options.rotation];
  }

  if (options.scale !== undefined) {
    root.scale = [options.scale, options.scale, options.scale];
  }

  json.nodes = [...(json.nodes ?? []), root];
  scene.nodes = [json.nodes.length - 1];
  json.scenes = scenes;

  validateJson(json, bin?.byteLength ?? 0);

  const jsonChunk = chunk(CHUNK_JSON, new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binChunk = bin ? chunk(CHUNK_BIN, bin, 0) : new Uint8Array(0);
  const out = new Uint8Array(12 + jsonChunk.byteLength + binChunk.byteLength);
  const view = new DataView(out.buffer);

  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  out.set(jsonChunk, 12);
  out.set(binChunk, 12 + jsonChunk.byteLength);

  return out;
}
