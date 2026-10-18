import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useDocumentPreviewStore } from '../../web/src/stores/documentPreview.ts';

test('общий viewer переключается между документом и изображением без двух модалок', () => {
  setActivePinia(createPinia());
  const preview = useDocumentPreviewStore();

  preview.show('#/documents?source=grigdesk&path=README.md');
  assert.equal(preview.visible, true);
  assert.equal(preview.image, null);

  preview.showImage({ src: '/api/chat/files/shot.png', name: 'shot.png', mime: 'image/png' });
  assert.equal(preview.href, '');
  assert.deepEqual(preview.image, {
    src: '/api/chat/files/shot.png', name: 'shot.png', mime: 'image/png',
  });

  // Фрагмент записи из разбора встречи показывает тот же viewer: вторая такая же
  // модалка рядом означала бы и второй Escape-слой, и свой возврат фокуса.
  preview.showVideo({ src: '/api/media/clip/0123456789abcdef/p0-00256-030s.mp4', name: 'Фрагмент 04:16 – 04:46' });
  assert.equal(preview.image, null, 'картинка и видео не показываются вместе');
  assert.equal(preview.href, '');
  assert.deepEqual(preview.video, {
    src: '/api/media/clip/0123456789abcdef/p0-00256-030s.mp4',
    name: 'Фрагмент 04:16 – 04:46',
    mime: '',
  });

  preview.showImage({ src: '/api/chat/files/shot.png', name: 'shot.png', mime: 'image/png' });
  assert.equal(preview.video, null, 'картинка гасит видео, а не ложится поверх него');

  preview.close();
  assert.equal(preview.visible, false);
  assert.equal(preview.image, null);
  assert.equal(preview.video, null);
});
