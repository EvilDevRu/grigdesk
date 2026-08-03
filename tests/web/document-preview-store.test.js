import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useDocumentPreviewStore } from '../../web/src/stores/document-preview.js';

test('общий viewer переключается между документом и изображением без двух модалок', () => {
  setActivePinia(createPinia());
  const preview = useDocumentPreviewStore();

  preview.show('#/documents?source=cockpit&path=README.md');
  assert.equal(preview.visible, true);
  assert.equal(preview.image, null);

  preview.showImage({ src: '/api/chat/files/shot.png', name: 'shot.png', mime: 'image/png' });
  assert.equal(preview.href, '');
  assert.deepEqual(preview.image, {
    src: '/api/chat/files/shot.png', name: 'shot.png', mime: 'image/png',
  });

  preview.close();
  assert.equal(preview.visible, false);
  assert.equal(preview.image, null);
});
