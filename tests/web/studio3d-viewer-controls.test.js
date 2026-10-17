import assert from 'node:assert/strict';
import test from 'node:test';
import { packGlb, sceneFixture } from './helpers/studio3d-viewer-fixtures.js';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const THREE_MODULE = webFile('node_modules/three/build/three.module.js');
const CLIP = 'Поворот кости';
const SECOND_CLIP = 'Повтор поворота';
let compiled = null;

/**
 * Движок собирается один раз на файл: счётчики и классы three живут в этой сборке.
 * Подменены только WebGLRenderer (запоминает сцену последнего render) и OrbitControls.
 */
function loadEngine() {
  compiled ??= compileModule(webFile('src/shared/viewer3d/engine.ts'), {
    stubs: {
      three: `export * from '${THREE_MODULE}';
        export class WebGLRenderer {
          setPixelRatio() {} setClearColor() {} setSize() {}
          render(scene) { globalThis.__studioRenderedScene = scene; }
          dispose() {} forceContextLoss() {}
        }`,
      'three/addons/controls/OrbitControls.js': `import { Vector3 } from '${THREE_MODULE}';
        export class OrbitControls {
          target = new Vector3(); addEventListener() {} removeEventListener() {} update() {} dispose() {}
        }`,
    },
  });

  return compiled;
}

/**
 * Окно happy-dom, fetch с настоящим GLB и ручной RAF: кадр вызывается тестом с явным now.
 * Второй клип повторяет первый под другим именем — им проверяется старт с нуля.
 */
async function setupViewer(t) {
  await installUiBrowser(t);

  const fixture = sceneFixture();
  const frames = new Map();
  let nextFrame = 0;

  fixture.json.animations.push({
    ...fixture.json.animations[0],
    name: SECOND_CLIP
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(packGlb(fixture)));
  t.mock.method(globalThis, 'requestAnimationFrame', (callback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);

    return nextFrame;
  });
  t.mock.method(globalThis, 'cancelAnimationFrame', (id) => {
    frames.delete(id);
  });

  const engine = await loadEngine();

  t.after(() => {
    delete globalThis.__studioRenderedScene;
  });
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });

  return {
    engine,
    frames,
    /**
     * Выполняет единственный ожидающий кадр с явным now; движок сам ставит следующий.
     * Два ожидающих кадра значили бы утечку RAF, поэтому их число проверяется.
     */
    runFrame(now) {
      assert.equal(frames.size, 1);

      const [[id, callback]] = frames;

      frames.delete(id);
      callback(now);
    },
  };
}

/**
 * Угол поворота кости вокруг Z по кватерниону (x и y у фикстуры нулевые).
 */
function boneAngle() {
  const bone = globalThis.__studioRenderedScene.getObjectByName('Кость');

  return 2 * Math.atan2(bone.quaternion.z, bone.quaternion.w);
}

function near(actual, expected, label) {
  assert.equal(Math.abs(actual - expected) < 1e-6, true, `${label}: ${actual} != ${expected}`);
}

test('VC-01 режимы, части и кости через публичный createEngine', { timeout: 60_000 }, async (t) => {
  const { engine } = await setupViewer(t);
  const viewer = engine.createEngine(document.createElement('canvas'));

  t.after(() => viewer.dispose());
  await viewer.load('/api/studio3d/files/model/v1/model.glb', 'glb');

  const scene = globalThis.__studioRenderedScene;
  const body = scene.getObjectByName('Тело');
  const base = scene.getObjectByName('Основание');
  const bodyOriginal = body.material;
  const baseOriginal = base.material;
  let helper = null;

  scene.traverse((object) => {
    if (object.isSkeletonHelper) {
      helper = object;
    }
  });
  assert.equal(Boolean(helper), true);
  assert.equal(helper.visible, false);

  viewer.setMode('clay');
  assert.equal(body.material === bodyOriginal, false);
  assert.equal(base.material === baseOriginal, false);
  assert.equal(body.material.wireframe, false);

  const clay = body.material;

  viewer.setMode('wire');
  assert.equal(body.material === bodyOriginal, false);
  assert.equal(body.material === clay, true);
  assert.equal(body.material.wireframe, true);
  assert.equal(base.material.wireframe, true);

  viewer.setMode('texture');
  assert.equal(body.material === bodyOriginal, true);
  assert.equal(base.material === baseOriginal, true);

  viewer.showParts(true);
  assert.equal(body.material === bodyOriginal, false);
  assert.equal(body.material.wireframe, false);
  t.diagnostic(`части: ${body.material.color.getHexString()} ${base.material.color.getHexString()}`);
  assert.notEqual(body.material.color.getHex(), base.material.color.getHex());

  viewer.showParts(false);
  assert.equal(body.material === bodyOriginal, true);

  viewer.showBones(true);
  assert.equal(helper.visible, true);
  viewer.showBones(false);
  assert.equal(helper.visible, false);
});

test('VC-02 клип, скорость, пауза, seek и смена клипа двигают настоящую кость', {
  timeout: 60_000
}, async (t) => {
  const { engine, runFrame } = await setupViewer(t);
  const viewer = engine.createEngine(document.createElement('canvas'));

  t.after(() => viewer.dispose());

  const info = await viewer.load('/api/studio3d/files/model/v1/model.glb', 'glb');

  assert.deepEqual(info.clips.map((clip) => clip.name), [CLIP, SECOND_CLIP]);
  viewer.playClip(CLIP);
  runFrame(1000);
  near(boneAngle(), 0, 'первый кадр без delta');
  runFrame(1100);
  t.diagnostic(`угол после 0,1 с: ${boneAngle()}`);
  near(boneAngle(), 0.65 * 0.1, 'шаг 0,1 с');

  viewer.setSpeed(2);
  runFrame(1200);
  t.diagnostic(`угол после шага при speed 2: ${boneAngle()}`);
  near(boneAngle(), 0.65 * 0.1 + 0.65 * 0.2, 'speed 2');

  viewer.playClip('');
  runFrame(1300);
  near(boneAngle(), 0.65 * 0.3, 'пауза');

  viewer.setTime(1);
  t.diagnostic(`угол после setTime(1): ${boneAngle()}`);
  near(boneAngle(), 0.65, 'setTime(1)');
  runFrame(1400);
  near(boneAngle(), 0.65, 'пауза после seek');

  viewer.setSpeed(1);
  viewer.playClip(SECOND_CLIP);
  runFrame(1500);
  t.diagnostic(`угол второго клипа после 0,1 с: ${boneAngle()}`);
  near(boneAngle(), 0.65 * 0.1, 'второй клип с нуля');

  viewer.dispose();
  viewer.dispose();
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});

/**
 * Подписывает счётчики dispose на материал и geometry сетки.
 */
function countDispose(target, counts, key) {
  counts[key] = 0;
  target.addEventListener('dispose', () => {
    counts[key] += 1;
  });
}

/**
 * Снимает оригиналы (режим texture без частей) и заменители (clay с частями) сцены.
 * Возвращает объект счётчиков по ключам «сетка/вид ресурса».
 */
function trackModel(viewer) {
  const scene = globalThis.__studioRenderedScene;
  const counts = {};

  viewer.setMode('texture');
  viewer.showParts(false);

  for (const name of ['Тело', 'Основание']) {
    const mesh = scene.getObjectByName(name);

    countDispose(mesh.material, counts, `${name}/оригинал`);
    countDispose(mesh.geometry, counts, `${name}/geometry`);
  }

  viewer.setMode('clay');
  viewer.showParts(true);

  for (const name of ['Тело', 'Основание']) {
    countDispose(scene.getObjectByName(name).material, counts, `${name}/заменитель`);
  }

  scene.traverse((object) => {
    if (object.isSkeletonHelper) {
      countDispose(object.geometry, counts, 'кости/geometry');
      countDispose(object.material, counts, 'кости/material');
    }
  });

  return counts;
}

function onceEach(counts) {
  return Object.fromEntries(Object.keys(counts).map((key) => [key, 1]));
}

test('VC-03 смена src и dispose в clay с частями освобождают каждый ресурс один раз', {
  timeout: 60_000
}, async (t) => {
  const { engine } = await setupViewer(t);
  const viewer = engine.createEngine(document.createElement('canvas'));

  t.after(() => viewer.dispose());
  await viewer.load('/api/studio3d/files/model/v1/model.glb', 'glb');

  const first = trackModel(viewer);

  assert.equal(Object.values(first).every((value) => value === 0), true);
  await viewer.load('/api/studio3d/files/model/v2/model.glb', 'glb');
  t.diagnostic(`после смены src: ${JSON.stringify(first)}`);
  assert.deepEqual(first, onceEach(first));

  const second = trackModel(viewer);

  viewer.dispose();
  t.diagnostic(`после dispose: ${JSON.stringify(second)}`);
  assert.deepEqual(second, onceEach(second));
  assert.deepEqual(first, onceEach(first));
  viewer.dispose();
  assert.deepEqual(second, onceEach(second));
  assert.deepEqual(engine.viewerDiagnostics(), { contexts: 0, memory: 0 });
});
