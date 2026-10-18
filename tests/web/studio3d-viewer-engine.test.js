import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModel, disposeModel } from '../../web/src/shared/viewer3d/engine.ts';
import { createResourcePolicy } from '../../web/src/shared/viewer3d/resourcePolicy.ts';
import { makeGlb } from '../server/helpers/studio3dGlb.js';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const THREE_MODULE = webFile('node_modules/three/build/three.module.js');
let viewerEngine = null;

/**
 * Engine собирается один раз на файл: счётчики, WeakMap и классы three живут в этой сборке.
 * Заглушка GLTFLoader отдаёт сцену теста и передаёт ему three этой же сборки и manager разбора.
 */
function loadViewerEngine() {
  viewerEngine ??= compileModule(webFile('src/shared/viewer3d/engine.ts'), {
    stubs: {
      three: `export * from '${THREE_MODULE}';
        export class WebGLRenderer {
          constructor() { this.lost = 0; (globalThis.__studioRenderers ||= []).push(this); }
          setPixelRatio() {} setClearColor() {} setSize() {}
          render(scene) { this.scene = scene; }
          dispose() {} forceContextLoss() { this.lost += 1; }
        }`,
      'three/addons/loaders/GLTFLoader.js': `import * as THREE from '${THREE_MODULE}';
        export class GLTFLoader {
          constructor(manager) { this.manager = manager; }
          setMeshoptDecoder() { return this; }
          async parseAsync(data, path) {
            return globalThis.__studioBudgetScene({ THREE, manager: this.manager, path });
          }
        }`,
      'three/addons/controls/OrbitControls.js':
        `import { Vector3 } from '${THREE_MODULE}';
        export class OrbitControls {
          target = new Vector3(); addEventListener() {} removeEventListener() {} update() {} dispose() {}
        }`
    }
  });

  return viewerEngine;
}

test('WV-08 два движка держат по 300 МиБ резерва одновременно', async (t) => {
  await installUiBrowser(t);

  const three = await import('../../web/node_modules/three/build/three.module.js');

  globalThis.__studioBudgetScene = () => {
    const geometry = new three.BufferGeometry();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

    // Реальные координаты малы; завышенная длина имитирует заявленный резерв RAM/GPU.
    Object.defineProperty(positions, 'byteLength', { value: 150 * 1024 * 1024 });
    geometry.setAttribute('position', new three.BufferAttribute(positions, 3));

    return {
      scene: new three.Mesh(geometry, new three.MeshStandardMaterial()),
      animations: []
    };
  };
  t.mock.method(globalThis, 'fetch', async () => new Response(makeGlb()));
  t.mock.method(globalThis, 'requestAnimationFrame', () => 1);
  t.mock.method(globalThis, 'cancelAnimationFrame', () => {});

  const engine = await loadViewerEngine();
  const first = engine.createEngine(document.createElement('canvas'));
  const second = engine.createEngine(document.createElement('canvas'));

  t.after(() => {
    first.dispose();
    second.dispose();
    delete globalThis.__studioBudgetScene;
  });
  await first.load('/api/studio3d/files/model/v1/model.glb', 'glb');
  await second.load('/api/studio3d/files/model/v2/model.glb', 'glb');
  assert.equal(engine.viewerDiagnostics().memory, 600 * 1024 * 1024);
  first.dispose();
  second.dispose();
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});

test('WV-02 настоящий GLTF/OBJ/STL parser без WebGL', async () => {
  const glb = await parseModel(makeGlb({ triangles: 12, animation: { name: 'Шаг', duration: 2 } }), 'glb');
  
  assert.equal(glb.stats.triangles, 12);
  assert.equal(glb.clips[0].name, 'Шаг');
  assert.equal(glb.clips[0].duration, 2);
  disposeModel(glb.scene);
  
  const source = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 1 1 0', 'f 1 2 3', 'f 2 4 3'].join('\n');
  const obj = await parseModel(new TextEncoder().encode(source), 'obj');
  
  assert.equal(obj.stats.triangles, 2);
  disposeModel(obj.scene);
  
  const bytes = new Uint8Array(84 + 3 * 50);
  
  new DataView(bytes.buffer).setUint32(80, 3, true);
  
  const stl = await parseModel(bytes, 'stl');
  
  assert.equal(stl.stats.triangles, 3);
  disposeModel(stl.scene);
});

test('WV-06 resource policy отвергает внешнее, traversal и чужой API до сети', () => {
  const token = 'a'.repeat(48);
  const root = `/api/studio3d/viewer/file/${token}/`;
  const policy = createResourcePolicy(`${root}hero.gltf`, 'https://grigdesk.test');
  
  assert.equal(policy.resolve('textures/skin.png'), `${root}textures/skin.png`);
  
  for (const uri of ['https://outside.test/a.bin', '//outside.test/a.bin', 'file:///tmp/a',
    '/api/preferences', '../a.bin', '%2e%2e/a.bin', '%252e%252e/a.bin', 'blob:foreign',
    'textures/a.ktx2', 'data:text/html;base64,PHNjcmlwdD4=']) {
    assert.throws(() => policy.resolve(uri), undefined, uri);
  }
  
  assert.throws(() => createResourcePolicy('/api/preferences', 'https://grigdesk.test'));
  assert.throws(() => createResourcePolicy('https://outside.test/model.glb', 'https://grigdesk.test'));
});

test('WV-06 реальные FBX/meshopt/skin/parts/splat fixtures', async () => {
  const { sceneFixture, packGlb, meshoptFixture, fbxFixture, splatFixture } =
    await import('./helpers/studio3d-viewer-fixtures.js');
  const skin = await parseModel(packGlb(sceneFixture()), 'glb');

  assert.equal(skin.stats.bones, 1);
  assert.equal(skin.parts.length, 2);
  assert.equal(skin.stats.triangles, 24);
  assert.equal(skin.clips[0].tracks[0].values[6] > 0.5, true);
  disposeModel(skin.scene);

  const compressed = await parseModel(await meshoptFixture(), 'glb');

  assert.equal(compressed.stats.triangles, 24);
  assert.equal(compressed.stats.size[1] > 1, true);
  disposeModel(compressed.scene);

  const fbx = await parseModel(fbxFixture(), 'fbx');

  assert.equal(fbx.stats.triangles, 1);
  disposeModel(fbx.scene);

  const splat = await parseModel(splatFixture(), 'splat');

  assert.equal(splat.stats.vertices, 80);
  assert.equal(splat.splat, true);
  disposeModel(splat.scene);
});

test('WV-06 циклы/глубина/texture bomb/Draco/FBX URI отклоняются до fetch', async (t) => {
  const { sceneFixture, packGlb, fbxFixture } = await import('./helpers/studio3d-viewer-fixtures.js');
  let requests = 0;

  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    
    throw new Error('Не должен вызываться fetch');
  });

  for (const uri of ['https://outside.test/a.bin', '/api/preferences', '../a.bin', '%252e%252e/a.bin']) {
    const fixture = sceneFixture();

    fixture.json.buffers[0].uri = uri;
    await assert.rejects(parseModel(packGlb(fixture), 'glb'), /ресурс|папк|Внешн/i);
  }

  const cyclic = sceneFixture();

  cyclic.json.nodes[0].children = [0];
  await assert.rejects(parseModel(packGlb(cyclic), 'glb'), /цикл/i);

  const deep = sceneFixture();

  deep.json.nodes = Array.from({ length: 300 }, (_, id) => ({ children: id < 299 ? [id + 1] : [] }));
  await assert.rejects(parseModel(packGlb(deep), 'glb'), /глубин/i);

  const draco = sceneFixture();

  draco.json.extensionsUsed = ['KHR_draco_mesh_compression'];
  await assert.rejects(parseModel(packGlb(draco), 'glb'), /Draco/);
  await assert.rejects(parseModel(new Uint8Array(), 'zip'), /архив/);

  const malicious = Buffer.concat([fbxFixture(), Buffer.from('\nTexture: "https://outside.test/a.png"')]);

  await assert.rejects(parseModel(malicious, 'fbx'), /Внешн/);
  assert.equal(requests, 0);
});

test('WV-06 raster и compressed FBX bomb отвергаются до addon decode', async () => {
  const { deflateSync } = await import('node:zlib');
  const { sceneFixture, packGlb, texturePng } = await import('./helpers/studio3d-viewer-fixtures.js');
  const fixture = sceneFixture();
  const image = Buffer.from(texturePng);

  image.writeUInt32BE(10000, 16);
  image.writeUInt32BE(10000, 20);
  fixture.json.images = [{ uri: 'data:image/png;base64,' + image.toString('base64') }];
  await assert.rejects(parseModel(packGlb(fixture), 'glb'), /64 Мп/);

  const compressed = deflateSync(Buffer.alloc(4096));
  const name = Buffer.from('Vertices');
  const properties = Buffer.alloc(13 + compressed.length);
  const end = 27 + 13 + name.length + properties.length;
  const bytes = Buffer.alloc(end + 13);

  bytes.write('Kaydara FBX Binary  \0\x1a\0', 0, 'latin1');
  bytes.writeUInt32LE(7400, 23);
  bytes.writeUInt32LE(end, 27);
  bytes.writeUInt32LE(1, 31);
  bytes.writeUInt32LE(properties.length, 35);
  bytes[39] = name.length;
  name.copy(bytes, 40);
  properties[0] = 102;
  properties.writeUInt32LE(3, 1);
  properties.writeUInt32LE(1, 5);
  properties.writeUInt32LE(compressed.length, 9);
  compressed.copy(properties, 13);
  properties.copy(bytes, 40 + name.length);
  await assert.rejects(parseModel(bytes, 'fbx'), /Распакованный массив/);
});

const WEB_ROOT = fileURLToPath(new URL('../../web', import.meta.url));
const SRC_ROOT = path.join(WEB_ROOT, 'src');
const VIEWER_DIR = path.join(SRC_ROOT, 'shared/viewer3d');
// Тяжёлые модули движка: имя добавляется вместе с реальным переносом, каталог целиком — нет.
const HEAVY = ['engine.ts', 'modelParser.ts', 'modelDisposal.ts', 'viewerMaterials.ts',
  'viewerAnimation.ts', 'viewerBudget.ts', 'viewerLoading.ts'];
// import/export … from без type, в том числе многострочный, и import 'x' без связываний.
const FROM_CLAUSE = /^\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm;
const BARE_IMPORT = /^\s*import\s*['"]([^'"]+)['"]/gm;

/**
 * Статические runtime-спецификаторы файла: import/export … from и import 'x'.
 * import type и export type не считаются; import { type X } остаётся runtime-импортом.
 */
function staticSpecifiers(text) {
  const fromClauses = [...text.matchAll(FROM_CLAUSE)];
  const bare = [...text.matchAll(BARE_IMPORT)];

  return [...fromClauses, ...bare].map((match) => match[1]);
}

/**
 * Все .ts/.js/.vue каталога src в отсортированном порядке: readdir порядка не обещает.
 * Сортировка делает сообщение о нарушителях одинаковым на любой файловой системе.
 */
async function sourceFiles(root) {
  const files = [];
  const stack = [root];

  while (stack.length) {
    const folder = stack.pop();

    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);

      if (entry.isDirectory()) {
        stack.push(file);
      } else if (/\.(?:ts|js|vue)$/.test(entry.name)) {
        files.push(file);
      }
    }
  }

  return files.sort();
}

/**
 * Статическое замыкание входа в графе metafile.inputs по рёбрам import-statement.
 * Рёбра dynamic-import не проходятся: за ними начинается ленивый чанк движка.
 */
function staticClosure(inputs, start) {
  const seen = new Set();
  const stack = [start];

  while (stack.length) {
    const current = stack.pop();

    if (seen.has(current) || !inputs[current]) {
      continue;
    }

    seen.add(current);
    stack.push(...inputs[current].imports
      .filter((item) => item.kind === 'import-statement')
      .map((item) => item.path));
  }

  return [...seen];
}

test('WV-04 Three и тяжёлые модули viewer доступны только через динамический engine', async () => {
  const heavyFiles = HEAVY.map((name) => path.join(VIEWER_DIR, name));
  const offenders = [];

  for (const file of await sourceFiles(SRC_ROOT)) {
    const internal = heavyFiles.includes(file);

    for (const specifier of staticSpecifiers(await readFile(file, 'utf8'))) {
      const three = specifier === 'three' || specifier.startsWith('three/');
      const target = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;

      if (!internal && (three || heavyFiles.includes(target))) {
        offenders.push(`${path.relative(SRC_ROOT, file)} → ${specifier}`);
      }
    }
  }

  assert.deepEqual(offenders, []);

  const esbuild = createRequire(path.join(WEB_ROOT, 'package.json'))('esbuild');
  const { metafile } = await esbuild.build({
    entryPoints: [path.join(VIEWER_DIR, 'viewerEngine.ts')],
    bundle: true,
    metafile: true,
    write: false,
    format: 'esm',
    logLevel: 'silent',
    absWorkingDir: WEB_ROOT,
  });
  const entry = 'src/shared/viewer3d/viewerEngine.ts';
  const engine = 'src/shared/viewer3d/engine.ts';
  const heavyInputs = HEAVY.map((name) => `src/shared/viewer3d/${name}`);
  const light = staticClosure(metafile.inputs, entry);

  assert.equal(light.some((input) => input.includes('node_modules/three/')), false);
  assert.equal(light.some((input) => heavyInputs.includes(input)), false);
  assert.equal(metafile.inputs[entry].imports
    .some((item) => item.kind === 'dynamic-import' && item.path === engine), true);
  assert.equal(staticClosure(metafile.inputs, engine)
    .includes('node_modules/three/build/three.module.js'), true);
});

/**
 * FileLoader three создаёт ProgressEvent на каждом куске потока, а в Node 22 его нет.
 * Без подмены разбор glTF с внешним буфером падает unhandledRejection.
 */
function installProgressEvent(t) {
  if (typeof globalThis.ProgressEvent === 'function') {
    return;
  }

  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  t.after(() => {
    delete globalThis.ProgressEvent;
  });
}

test('WV-02 glTF с внешним .bin и data: буфером разбирается и отзывает свой Blob', {
  timeout: 60_000
}, async (t) => {
  const { sceneFixture } = await import('./helpers/studio3d-viewer-fixtures.js');
  const source = '/api/studio3d/files/offline/fixture/model.bin';
  const original = globalThis.fetch;
  const requests = [];
  let binary = null;

  installProgressEvent(t);
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;

    requests.push(url);

    return url.startsWith('blob:') ? original(input, init) : new Response(binary);
  });

  const created = t.mock.method(URL, 'createObjectURL');
  const revoked = t.mock.method(URL, 'revokeObjectURL');

  for (const external of [true, false]) {
    const fixture = sceneFixture();

    binary = fixture.binary;
    fixture.json.buffers[0].uri = external ? 'model.bin'
      : `data:application/octet-stream;base64,${fixture.binary.toString('base64')}`;
    requests.length = 0;
    created.mock.resetCalls();
    revoked.mock.resetCalls();

    const parsed = await parseModel(new TextEncoder().encode(JSON.stringify(fixture.json)), 'gltf');
    const blobs = created.mock.calls.map((call) => call.result);

    assert.equal(parsed.stats.triangles, 24);
    assert.equal(parsed.standalone, !external);
    assert.equal(blobs.length, 1);
    assert.deepEqual(requests, external ? [source, blobs[0]] : [blobs[0]]);
    assert.equal(revoked.mock.callCount(), 0);
    disposeModel(parsed.scene);
    assert.deepEqual(revoked.mock.calls.map((call) => call.arguments[0]), blobs);
  }
});

test('WV-06 OBJ с mtllib отклоняется до разбора и сети', { timeout: 60_000 }, async (t) => {
  const requests = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Не должен вызываться fetch');
  });
  const source = ['mtllib model.mtl', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n');

  await assert.rejects(parseModel(new TextEncoder().encode(source), 'obj'), {
    message: 'OBJ с MTL не поддержан; сохраните самостоятельный GLB.'
  });
  assert.equal(requests.mock.callCount(), 0);
});

/**
 * Окно happy-dom, ручной RAF с учётом id и пустой журнал renderer для одного сценария.
 * Engine берётся из общей сборки файла; счётчики в начале сценария нулевые.
 */
async function prepareViewer(t) {
  await installUiBrowser(t);

  const frames = new Map();
  const cancelled = [];
  let next = 0;

  t.mock.method(globalThis, 'requestAnimationFrame', (callback) => {
    next += 1;
    frames.set(next, callback);

    return next;
  });
  t.mock.method(globalThis, 'cancelAnimationFrame', (id) => {
    cancelled.push(id);
    frames.delete(id);
  });
  globalThis.__studioRenderers = [];
  t.after(() => {
    delete globalThis.__studioRenderers;
    delete globalThis.__studioBudgetScene;
  });

  const engine = await loadViewerEngine();

  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });

  return {
    engine,
    frames,
    cancelled
  };
}

/**
 * Загрузка проходит fetch, поток и parser за несколько оборотов event loop.
 * Условие ждётся ограниченно, чтобы зависание стало понятным отказом.
 */
async function until(check) {
  for (let step = 0; step < 200 && !check(); step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(check(), true);
}

/**
 * Сцена из классов той же сборки three, иначе instanceof Texture в engine ложен.
 * ImageBitmap заменён объектом с close; Blob регистрируется через manager разбора.
 */
function trackedScene({ THREE, manager }, name, events) {
  const blob = URL.createObjectURL(new Blob([name]));
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const geometry = new THREE.BufferGeometry();
  const texture = new THREE.Texture({
    width: 1,
    height: 1,
    close: () => events.push(`${name}/close`)
  });
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);

  manager.resolveURL(blob);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  mesh.name = name;

  for (const [kind, target] of [['geometry', geometry], ['material', material], ['texture', texture]]) {
    target.addEventListener('dispose', () => events.push(`${name}/${kind}`));
  }

  events.push(`${name}/blob ${blob}`);

  return {
    scene: mesh,
    animations: [],
    parser: { associations: new Map() }
  };
}

function blobOf(events, name) {
  return events.find((event) => event.startsWith(`${name}/blob `)).slice(name.length + 6);
}

// Память trackedScene: позиции 36 байт × 2 и текстура 1 × 1 × 8.
const TRACKED_MEMORY = 80;

test('WV-09 смена src A→B отклоняет поздний A, освобождает его сцену и публикует B', {
  timeout: 60_000
}, async (t) => {
  const { engine } = await prepareViewer(t);
  const events = [];
  const revoked = t.mock.method(URL, 'revokeObjectURL');
  let releaseA = null;

  t.mock.method(globalThis, 'fetch', async () => new Response(makeGlb()));
  globalThis.__studioBudgetScene = (context) => {
    if (context.path.includes('/v1/')) {
      return new Promise((resolve) => {
        releaseA = () => resolve(trackedScene(context, 'A', events));
      });
    }

    return trackedScene(context, 'B', events);
  };

  const viewer = engine.createEngine(document.createElement('canvas'));

  t.after(() => viewer.dispose());

  const first = viewer.load('/api/studio3d/files/model/v1/model.glb', 'glb');

  await until(() => releaseA !== null);

  const info = await viewer.load('/api/studio3d/files/model/v2/model.glb', 'glb');

  assert.equal(info.stats.meshes, 1);
  releaseA();
  await assert.rejects(first, { name: 'AbortError' });

  const rendered = globalThis.__studioRenderers.at(-1).scene;

  assert.deepEqual(events.filter((event) => event.startsWith('A/') && !event.startsWith('A/blob')),
    ['A/geometry', 'A/material', 'A/close', 'A/texture']);
  assert.deepEqual(revoked.mock.calls.map((call) => call.arguments[0]), [blobOf(events, 'A')]);
  assert.equal(events.some((event) => event.startsWith('B/') && !event.startsWith('B/blob')), false);
  assert.equal(Boolean(rendered.getObjectByName('B')), true);
  assert.equal(Boolean(rendered.getObjectByName('A')), false);
  assert.equal(engine.viewerDiagnostics().memory, TRACKED_MEMORY);
  viewer.dispose();
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});

test('WV-10 после dispose progress не публикуется, а резерв загрузки возвращается', {
  timeout: 60_000
}, async (t) => {
  const { engine } = await prepareViewer(t);
  const bytes = makeGlb();
  const progress = [];
  let stream = null;

  t.mock.method(globalThis, 'fetch', async (input, init) => new Response(new ReadableStream({
    start(controller) {
      stream = controller;
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
    }
  })));

  const viewer = engine.createEngine(document.createElement('canvas'), {
    onProgress: (loaded) => progress.push(loaded)
  });
  const loading = viewer.load('/api/studio3d/files/model/v1/model.glb', 'glb');

  await until(() => stream !== null);
  stream.enqueue(bytes.subarray(0, 8));
  await until(() => progress.length === 1);
  assert.deepEqual(progress, [8]);
  assert.equal(engine.viewerDiagnostics().memory, 16);

  // Кусок уже отдан ожидающему read; dispose происходит до того, как engine его увидит.
  stream.enqueue(bytes.subarray(8));
  viewer.dispose();
  await assert.rejects(loading, { name: 'AbortError' });
  assert.deepEqual(progress, [8]);
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});

test('WV-11 скрытие отменяет кадр и не ставит новый, показ ставит один', { timeout: 60_000 }, async (t) => {
  const { engine, frames, cancelled } = await prepareViewer(t);
  const viewer = engine.createEngine(document.createElement('canvas'));

  t.after(() => viewer.dispose());
  assert.deepEqual([...frames.keys()], [1]);
  viewer.setVisible(false);
  assert.deepEqual(cancelled, [1]);
  assert.equal(frames.size, 0);
  viewer.setVisible(false);
  assert.deepEqual(cancelled, [1]);
  assert.equal(frames.size, 0);
  viewer.setVisible(true);
  assert.deepEqual([...frames.keys()], [2]);
  viewer.dispose();
  assert.deepEqual(cancelled, [1, 2]);
  assert.equal(frames.size, 0);
});

test('WV-12 потеря контекста до dispose сообщает ошибку и прерывает загрузку, после dispose — нет', {
  timeout: 60_000
}, async (t) => {
  const { engine, frames } = await prepareViewer(t);
  const canvas = document.createElement('canvas');
  const errors = [];
  let stream = null;

  t.mock.method(globalThis, 'fetch', async (input, init) => new Response(new ReadableStream({
    start(controller) {
      stream = controller;
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
    }
  })));

  const viewer = engine.createEngine(canvas, { onError: (message) => errors.push(message) });

  t.after(() => viewer.dispose());

  const loading = viewer.load('/api/studio3d/files/model/v1/model.glb', 'glb');

  await until(() => stream !== null);

  const lost = new Event('webglcontextlost', { cancelable: true });

  canvas.dispatchEvent(lost);
  assert.equal(lost.defaultPrevented, true);
  assert.deepEqual(errors, ['Контекст WebGL потерян. Закройте и откройте просмотр снова.']);
  assert.equal(frames.size, 0);
  await assert.rejects(loading, { name: 'AbortError' });
  await assert.rejects(viewer.load('/api/studio3d/files/model/v2/model.glb', 'glb'), {
    message: 'Просмотрщик закрыт или WebGL недоступен.'
  });
  assert.equal(engine.viewerDiagnostics().memory, 0);
  viewer.dispose();
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  assert.equal(errors.length, 1);
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});

test('WV-13 dispose освобождает Blob, ImageBitmap, GPU-ресурсы модели и контекст', {
  timeout: 60_000
}, async (t) => {
  const { engine } = await prepareViewer(t);
  const events = [];
  const revoked = t.mock.method(URL, 'revokeObjectURL');

  t.mock.method(globalThis, 'fetch', async () => new Response(makeGlb()));
  globalThis.__studioBudgetScene = (context) => trackedScene(context, 'M', events);

  const viewer = engine.createEngine(document.createElement('canvas'));

  t.after(() => viewer.dispose());
  await viewer.load('/api/studio3d/files/model/v1/model.glb', 'glb');

  const renderer = globalThis.__studioRenderers.at(-1);

  assert.equal(engine.viewerDiagnostics().memory, TRACKED_MEMORY);
  assert.equal(revoked.mock.callCount(), 0);
  viewer.dispose();
  assert.deepEqual(events.filter((event) => !event.startsWith('M/blob')),
    ['M/geometry', 'M/material', 'M/close', 'M/texture']);
  assert.deepEqual(revoked.mock.calls.map((call) => call.arguments[0]), [blobOf(events, 'M')]);
  assert.equal(renderer.lost, 1);
  viewer.dispose();
  assert.equal(renderer.lost, 1);
  assert.equal(revoked.mock.callCount(), 1);
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});
