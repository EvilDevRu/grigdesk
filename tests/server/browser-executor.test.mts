import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { codexDynamicToolResponse } from '../../server/src/lib/executors/codex.ts';
import { createCodexToolImages } from '../../server/src/lib/executors/_codexToolImages.ts';

test('BR15-I: screenshot становится inputImage без JSON/base64 в inputText', () => {
  const response = codexDynamicToolResponse({
    format: 'grigdesk-work-content-v1',
    content: [{
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'AQ=='
    }],
  });

  assert.deepEqual(response, {
    contentItems: [{ type: 'inputImage', imageUrl: 'data:image/jpeg;base64,AQ==' }], success: true,
  });
  assert.equal(codexDynamicToolResponse({ ok: false }).success, false);
});

test('BR15-II: параллельные миниатюры соблюдают квоту и приватные права файлов', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-tool-images-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const images = createCodexToolImages(root);

  await Promise.all(Array.from({ length: 33 }, (_, index) => (
    images.save(`call-${index}`, 'data:image/jpeg;base64,AQ==')
  )));

  const image = images.pathFor('call-0');
  const directory = path.dirname(image);

  assert.equal((await readdir(root)).length, 1);
  assert.equal((await readdir(directory)).length, 32);
  assert.equal(images.pathFor('call-32'), '');
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(image)).mode & 0o777, 0o600);

  await images.save('call-0', 'data:image/jpeg;base64,Ag==');
  assert.equal(images.pathFor('call-0'), image);
  assert.equal((await readdir(directory)).length, 32);
});
