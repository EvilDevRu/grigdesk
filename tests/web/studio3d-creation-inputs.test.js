import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile, singletonUrl } from './helpers/compile-vue.js';

/**
 * Настоящий модуль получает управляемые upload/decode; URL восстанавливаются после теста.
 * Vue ref берётся из того же singleton, который использует сборка модуля.
 */
async function harness(t, upload) {
  const { ref } = await import(singletonUrl('vue'));
  const { useCreationInputs } = await compileModule(webFile('src/features/studio3d/useCreationInputs.ts'));
  const revoked = [];
  let next = 0;
  let closed = 0;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;

  URL.createObjectURL = () => `blob:preview-${++next}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  t.after(() => {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  });

  const error = ref('');
  const inputs = useCreationInputs({
    upload,
    error,
    isAlive: () => true,
    readImage: async (file) => ({ file, bitmap: { close: () => {
      closed += 1;
    } } }),
  });

  return { 
    inputs, 
    error, 
    revoked, 
    closed: () => closed 
  };
}

test('CI-01 один File memoized до смены библиотеки, decode закрывается', async (t) => {
  let calls = 0;
  const h = await harness(t, async () => ({ uploadId: `upload-${++calls}` }));
  const file = new File(['image'], 'cat.png');

  await h.inputs.choosePrimary(file);
  await h.inputs.choosePrimary(file);
  assert.equal(calls, 1);
  assert.equal(h.closed(), 2);
  assert.equal(h.inputs.primaryUpload.value.uploadId, 'upload-1');
  h.inputs.resetForLibrary();
  assert.equal(h.inputs.primaryUpload.value, null);
  assert.equal(h.inputs.primaryName.value, 'cat.png');
  assert.equal(h.inputs.primaryPreview.value, 'blob:preview-2');
  await h.inputs.choosePrimary(file);
  assert.equal(calls, 2);
});

test('CI-02 отказ снимает cache для явного повтора', async (t) => {
  let calls = 0;
  const h = await harness(t, async () => {
    calls += 1;

    if (calls === 1) {
      throw new Error('Загрузка отклонена.');
    }

    return { uploadId: 'retry' };
  });
  const file = new File(['model'], 'cat.glb');

  await h.inputs.chooseOwnFile(file);
  assert.equal(h.error.value, 'Загрузка отклонена.');
  assert.equal(h.inputs.uploading.value, false);
  await h.inputs.chooseOwnFile(file);
  assert.equal(calls, 2);
  assert.equal(h.inputs.ownUpload.value.uploadId, 'retry');
  assert.equal(h.inputs.ownName.value, 'cat.glb');
});

test('CI-03 поздний ответ не возвращает очищенный primary', async (t) => {
  let release;
  const work = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, () => work);
  const choosing = h.inputs.choosePrimary(new File(['image'], 'cat.png'));

  await Promise.resolve();
  h.inputs.clearPrimary();
  release({ uploadId: 'old' });
  await choosing;
  assert.equal(h.inputs.primaryUpload.value, null);
  assert.equal(h.inputs.primaryPreview.value, '');
});

test('CI-04 замена и dispose отзывают Blob URL ровно по одному разу', async (t) => {
  const h = await harness(t, async () => ({ uploadId: 'image' }));

  await h.inputs.choosePrimary(new File(['a'], 'a.png'));
  await h.inputs.choosePrimary(new File(['b'], 'b.png'));
  assert.deepEqual(h.revoked, ['blob:preview-1']);
  h.inputs.dispose();
  h.inputs.dispose();
  assert.deepEqual(h.revoked, ['blob:preview-1', 'blob:preview-2']);
});

test('CI-05 перестановка видов сохраняет upload identity', async (t) => {
  let calls = 0;
  const h = await harness(t, async () => ({ uploadId: `view-${++calls}` }));
  const front = new File(['front'], 'front.png');
  const back = new File(['back'], 'back.png');

  await h.inputs.uploadViews({ 
    front, 
    back, 
    left: null, 
    right: null 
  });
  assert.deepEqual(h.inputs.viewUploads.value, [
    { role: 'front', uploadId: 'view-1' }, { role: 'back', uploadId: 'view-2' },
  ]);
  await h.inputs.uploadViews({ 
    front: back, 
    back: front, 
    left: null, 
    right: null 
  });
  assert.equal(calls, 2);
  assert.deepEqual(h.inputs.viewUploads.value, [
    { role: 'front', uploadId: 'view-2' }, { role: 'back', uploadId: 'view-1' },
  ]);
});

test('CI-06 неподдержанный own file даёт прежний текст до upload', async (t) => {
  let calls = 0;
  const h = await harness(t, async () => {
    calls += 1;
  });

  await h.inputs.chooseOwnFile(new File(['model'], 'cat.gltf'));
  assert.equal(h.error.value, 'Для импорта .gltf сохраните самостоятельный .glb.');
  await h.inputs.chooseOwnFile(new File(['model'], 'cat.txt'));
  assert.equal(h.error.value, 'Поддержаны GLB, FBX, OBJ, STL, splat до 150 МиБ.');
  assert.equal(calls, 0);
});
