import assert from 'node:assert/strict';
import test from 'node:test';
import { packGlb } from './helpers/studio3d-viewer-fixtures.js';
import { makeGlb, pngHeader } from '../server/helpers/studio3dGlb.js';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const MiB = 1024 * 1024;
const THREE_MODULE = webFile('node_modules/three/build/three.module.js');
let budgetEngine = null;

/**
 * Engine собирается один раз на файл: contexts и heldMemory читаются из этой же сборки.
 * WebGLRenderer бросает по флагу теста; GLTFLoader отдаёт сцену или обещание теста.
 */
function loadBudgetEngine() {
  budgetEngine ??= compileModule(webFile('src/shared/viewer3d/engine.ts'), {
    stubs: {
      three: `export * from '${THREE_MODULE}';
        export class WebGLRenderer {
          constructor() {
            if (globalThis.__studioRendererFails) throw new Error('WebGL недоступен в тесте.');
          }
          setPixelRatio() {} setClearColor() {} setSize() {} render() {}
          dispose() {} forceContextLoss() {}
        }`,
      'three/addons/loaders/GLTFLoader.js': `import * as THREE from '${THREE_MODULE}';
        export class GLTFLoader {
          setMeshoptDecoder() { return this; }
          async parseAsync(data, path) { return globalThis.__studioBudgetScene({ THREE, path }); }
        }`,
      'three/addons/controls/OrbitControls.js': `import { Vector3 } from '${THREE_MODULE}';
        export class OrbitControls {
          target = new Vector3(); addEventListener() {} removeEventListener() {} update() {} dispose() {}
        }`
    }
  });

  return budgetEngine;
}

/**
 * Окно happy-dom и пустой RAF: кадры в этих сценариях не нужны.
 * Сборка общая на файл, поэтому в начале сценария бюджет обязан быть свободен.
 */
async function prepareBudget(t) {
  await installUiBrowser(t);
  t.mock.method(globalThis, 'requestAnimationFrame', () => 1);
  t.mock.method(globalThis, 'cancelAnimationFrame', () => {});
  t.after(() => {
    delete globalThis.__studioBudgetScene;
    delete globalThis.__studioRendererFails;
  });

  const engine = await loadBudgetEngine();

  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });

  return engine;
}

/**
 * Сцена с завышенной длиной позиций: inspectScene считает её память как byteLength × 2.
 * Классы берутся из той же сборки three, что и engine; реальные координаты малы.
 */
function sizedScene(THREE, mebibytes, name) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());

  Object.defineProperty(positions, 'byteLength', { value: mebibytes * MiB / 2 });
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  mesh.name = name;

  return {
    scene: mesh,
    animations: []
  };
}

/**
 * GLB без геометрии: accessor MAT4 (count × 128 байт) и заголовок PNG (ширина × высота × 8)
 * объявляют объём, который parser резервирует до разбора. Заглушка GLTFLoader байты не читает.
 */
function declaredGlb(accessorMiB, image = null) {
  const json = {
    asset: { version: '2.0' },
    accessors: [{
      type: 'MAT4',
      componentType: 5126,
      count: accessorMiB * MiB / 128
    }]
  };
  let binary = Buffer.alloc(0);

  if (image) {
    binary = pngHeader(image[0], image[1]);
    json.buffers = [{ byteLength: binary.length }];
    json.bufferViews = [{
      buffer: 0,
      byteOffset: 0,
      byteLength: binary.length
    }];
    json.images = [{
      bufferView: 0,
      mimeType: 'image/png'
    }];
  }

  return packGlb({ json, binary });
}

/**
 * Загрузка проходит fetch, поток и parser за несколько оборотов event loop.
 */
async function until(check) {
  for (let step = 0; step < 200 && !check(); step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(check(), true);
}

test('VB-01 одновременные резервы 600 и 500 МиБ двух engine отклоняют второй до разбора', {
  timeout: 60_000
}, async (t) => {
  const engine = await prepareBudget(t);
  // 300 МиБ accessor и PNG 8192 × 4800 (300 МиБ) против accessor на 500 МиБ.
  const a = declaredGlb(300, [8192, 4800]);
  const b = declaredGlb(500);
  const reserveA = 2 * a.length + 600 * MiB;
  let releaseA = null;

  t.mock.method(globalThis, 'fetch', async (input) => new Response(String(input).includes('/a/') ? a : b));
  globalThis.__studioBudgetScene = ({ THREE, path }) => {
    if (!path.includes('/a/')) {
      return sizedScene(THREE, 2, 'B');
    }

    return new Promise((resolve) => {
      releaseA = () => resolve(sizedScene(THREE, 2, 'A'));
    });
  };

  const first = engine.createEngine(document.createElement('canvas'));
  const second = engine.createEngine(document.createElement('canvas'));

  t.after(() => {
    first.dispose();
    second.dispose();
  });

  const loadingA = first.load('/api/studio3d/files/model/a/model.glb', 'glb');

  await until(() => releaseA !== null);
  assert.equal(engine.viewerDiagnostics().memory, reserveA);
  await assert.rejects(second.load('/api/studio3d/files/model/b/model.glb', 'glb'), {
    message: 'Загрузка и две модели превышают общий бюджет 1024 МиБ.'
  });
  assert.equal(engine.viewerDiagnostics().memory, reserveA);
  releaseA();
  await loadingA;
  assert.equal(engine.viewerDiagnostics().memory, 2 * MiB);
  first.dispose();
  second.dispose();
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});

test('VB-02 отказ при публикации не публикует B и не меняет долю A', { timeout: 60_000 }, async (t) => {
  const engine = await prepareBudget(t);
  const disposed = [];

  t.mock.method(globalThis, 'fetch', async () => new Response(makeGlb()));
  globalThis.__studioBudgetScene = ({ THREE, path }) => {
    const name = path.includes('/a/') ? 'A' : 'B';
    const parsed = sizedScene(THREE, name === 'A' ? 600 : 500, name);

    parsed.scene.geometry.addEventListener('dispose', () => disposed.push(name));

    return parsed;
  };

  const first = engine.createEngine(document.createElement('canvas'));
  const second = engine.createEngine(document.createElement('canvas'));

  t.after(() => {
    first.dispose();
    second.dispose();
  });
  await first.load('/api/studio3d/files/model/a/model.glb', 'glb');
  assert.equal(engine.viewerDiagnostics().memory, 600 * MiB);
  await assert.rejects(second.load('/api/studio3d/files/model/b/model.glb', 'glb'), {
    message: 'Две модели превышают общий бюджет 1024 МиБ.'
  });
  assert.deepEqual(disposed, ['B']);
  await assert.rejects(second.snapshot(), { message: 'Для снимка нужна загруженная модель.' });
  assert.equal(engine.viewerDiagnostics().memory, 600 * MiB);
  first.dispose();
  second.dispose();
  assert.deepEqual(disposed, ['B', 'A']);
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});

test('VB-03 поздно дочитанный A на том же engine освобождает только свой резерв', {
  timeout: 60_000
}, async (t) => {
  const engine = await prepareBudget(t);
  const a = declaredGlb(100);
  let streamA = null;

  t.mock.method(globalThis, 'fetch', async (input) => {
    if (!String(input).includes('/a/')) {
      return new Response(makeGlb());
    }

    return new Response(new ReadableStream({
      start(controller) {
        streamA = controller;
      }
    }));
  });
  globalThis.__studioBudgetScene = ({ THREE }) => sizedScene(THREE, 300, 'B');

  const viewer = engine.createEngine(document.createElement('canvas'));

  t.after(() => viewer.dispose());

  const loadingA = viewer.load('/api/studio3d/files/model/a/model.glb', 'glb');

  await until(() => streamA !== null);
  streamA.enqueue(a.subarray(0, 8));
  await until(() => engine.viewerDiagnostics().memory === 16);
  await viewer.load('/api/studio3d/files/model/b/model.glb', 'glb');
  assert.equal(engine.viewerDiagnostics().memory, 300 * MiB + 16);

  // Поток A не связан с abort: A дочитывается, резервирует 100 МиБ и отменяется в parser.
  streamA.enqueue(a.subarray(8));
  streamA.close();
  await assert.rejects(loadingA, { name: 'AbortError' });
  assert.equal(engine.viewerDiagnostics().memory, 300 * MiB);
  viewer.dispose();
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});

test('VB-04 неудачный WebGLRenderer не занимает слот, третий холст отклоняется', {
  timeout: 60_000
}, async (t) => {
  const engine = await prepareBudget(t);

  globalThis.__studioRendererFails = true;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => engine.createEngine(document.createElement('canvas')), {
      message: 'WebGL недоступен в тесте.'
    });
  }

  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
  globalThis.__studioRendererFails = false;

  const first = engine.createEngine(document.createElement('canvas'));
  const second = engine.createEngine(document.createElement('canvas'));

  t.after(() => {
    first.dispose();
    second.dispose();
  });
  assert.equal(engine.viewerDiagnostics().contexts, 2);
  assert.throws(() => engine.createEngine(document.createElement('canvas')), {
    message: 'Уже открыты два 3D холста. Закройте сравнение или другое окно.'
  });
  first.dispose();
  second.dispose();
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});
