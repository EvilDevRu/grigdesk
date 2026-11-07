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

// Стрелки просмотра листают только набор той же ленты и не перескакивают через края.
test('картинки ленты листаются по порядку и без перескока', () => {
  setActivePinia(createPinia());

  const preview = useDocumentPreviewStore();
  const gallery = ['a', 'b', 'c'].map((name) => ({ src: `/api/chat/files/${name}.png`, name }));

  preview.showImage({ src: '/api/chat/files/b.png', name: 'b' }, gallery);
  assert.equal(preview.galleryIndex, 1);
  preview.stepImage(1);
  assert.equal(preview.image.name, 'c');
  preview.stepImage(1);
  assert.equal(preview.image.name, 'c', 'на последней картинке шаг вперёд ничего не делает');
  preview.stepImage(-2);
  assert.equal(preview.image.name, 'a');

  preview.showImage({ src: '/api/chat/files/other.png' }, gallery);
  assert.deepEqual(preview.gallery, [], 'чужой набор без открытой картинки не принимается');
  preview.showImage({ src: '/api/chat/files/a.png' }, gallery);
  preview.showVideo({ src: '/api/video/clip.mp4' });
  assert.deepEqual(preview.gallery, [], 'видео не наследует стрелки картинок');
});
