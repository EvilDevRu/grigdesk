import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('просмотр изображений: жесты, границы, панели и смена медиа', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ createPinia }, { mount, flushPromises }, Viewer] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/MediaViewer.vue'), { expose: ['preview'] }),
  ]);
  const wrapper = mount(Viewer, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()] },
  });
  const preview = wrapper.vm.preview;
  const gallery = ['a', 'b'].map((name) => ({ src: `/api/test/${name}.png`, name: `${name}.png` }));
  const dimensions = { width: 400, height: 600 };
  let stage;
  let image;
  let captured;

  t.after(() => wrapper.unmount());

  /**
   * Happy DOM не рассчитывает геометрию: задаём размеры вписанного изображения явно.
   * События проходят настоящую разметку и публичные UI-компоненты без подмены viewer.
   */
  async function open() {
    preview.close();
    await flushPromises();
    preview.showImage(gallery[0], gallery);
    await flushPromises();
    stage = browser.document.querySelector('.media-viewer__stage');
    image = stage.querySelector('img');
    captured = new Set();
    stage.setPointerCapture = (id) => captured.add(id);
    stage.hasPointerCapture = (id) => captured.has(id);
    stage.releasePointerCapture = (id) => captured.delete(id);
    stage.getBoundingClientRect = () => ({
      left: 0,
      top: 56,
      ...dimensions,
    });

    for (const [element, sizes] of [
      [stage, { clientWidth: dimensions.width, clientHeight: dimensions.height }],
      [image, {
        clientWidth: 400,
        clientHeight: 300,
        naturalWidth: 1600,
        naturalHeight: 1200,
      }],
    ]) {
      for (const [name, value] of Object.entries(sizes)) {
        Object.defineProperty(element, name, { value, configurable: true });
      }
    }

    image.dispatchEvent(new browser.Event('load'));
    await flushPromises();
  }

  /**
   * Захват браузера после pointerdown моделируется доставкой продолжения на сцену.
   * Так проверяется и перенос с картинки, и второй палец на пустом поле вокруг неё.
   */
  async function pointer(type, id, x, y, target = stage) {
    target.dispatchEvent(new browser.PointerEvent(type, {
      pointerId: id,
      pointerType: 'touch',
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }));

    if (['pointerup', 'pointercancel'].includes(type)) {
      captured.delete(id);
    }

    await flushPromises();
  }

  await t.test('два пальца увеличивают картинку вокруг выбранной точки', async () => {
    await open();

    const bar = browser.document.querySelector('.media-viewer__bar');
    const counter = browser.document.querySelector('.media-viewer__count');

    await pointer('pointerdown', 1, 200, 356, image);
    await pointer('pointerdown', 2, 300, 356);
    await pointer('pointermove', 2, 400, 356);
    assert.equal(image.style.transform, 'translate(0px, 0px) scale(2)');
    assert.equal(stage.dataset.zoomed, 'true');
    assert.equal(bar.style.transform, '');
    assert.equal(counter.style.transform, '');
    assert.equal(counter.textContent, '1 из 2');

    // Отпускание второго пальца не меняет картинку; первый продолжает перенос.
    await pointer('pointerup', 2, 400, 356);
    await pointer('pointermove', 1, 240, 356);
    assert.equal(image.style.transform, 'translate(40px, 0px) scale(2)');
    stage.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    await flushPromises();
    assert.ok(preview.image, 'завершение жеста не закрывает изображение');
  });

  await t.test('размер 1:1 и перетаскивание достигают всех четырёх краёв', async () => {
    await open();
    browser.document.querySelector('[aria-label="Исходный размер"]').click();
    await flushPromises();
    assert.equal(image.style.transform, 'translate(0px, 0px) scale(4)');

    await pointer('pointerdown', 1, 200, 356, image);
    await pointer('pointermove', 1, 3000, 3000);
    assert.equal(image.style.transform, 'translate(600px, 300px) scale(4)');
    await pointer('pointermove', 1, -3000, -3000);
    assert.equal(image.style.transform, 'translate(-600px, -300px) scale(4)');
    await pointer('pointerup', 1, -3000, -3000);

    browser.document.querySelector('[aria-label="Вписать в экран"]').click();
    await flushPromises();
    assert.equal(image.style.transform, 'translate(0px, 0px) scale(1)');
  });

  await t.test('обычное нажатие после захвата не закрывает картинку, двойное меняет масштаб', async () => {
    await open();
    await pointer('pointerdown', 1, 200, 356, image);
    await pointer('pointerup', 1, 200, 356);
    stage.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    await flushPromises();
    assert.ok(preview.image);

    for (const expected of [3, 1]) {
      image.dispatchEvent(new browser.MouseEvent('dblclick', {
        clientX: 200,
        clientY: 356,
        bubbles: true,
        cancelable: true,
      }));
      await flushPromises();
      assert.equal(image.style.transform, `translate(0px, 0px) scale(${expected})`);
    }
  });

  await t.test('отмена жеста и следующая картинка сбрасывают захваченные указатели', async () => {
    await open();
    await pointer('pointerdown', 1, 100, 356, image);
    await pointer('pointerdown', 2, 200, 356);
    await pointer('pointermove', 2, 400, 356);
    await pointer('pointercancel', 2, 400, 356);
    await pointer('pointermove', 1, 120, 356);
    assert.equal(image.style.transform, 'translate(220px, 0px) scale(3)');

    browser.document.querySelector('[aria-label="Следующее изображение"]').click();
    await flushPromises();
    assert.equal(preview.image.name, 'b.png');
    assert.equal(captured.size, 0);
    assert.equal(stage.querySelector('img').style.transform, 'translate(0px, 0px) scale(1)');
    await pointer('pointermove', 1, 300, 356);
    assert.equal(stage.querySelector('img').style.transform, 'translate(0px, 0px) scale(1)');
  });

  await t.test('уменьшение останавливается на вписанном виде, фон закрывает только обычный тап', async () => {
    await open();
    await pointer('pointerdown', 1, 100, 356, image);
    await pointer('pointerdown', 2, 300, 356);
    await pointer('pointermove', 2, 150, 356);
    assert.equal(image.style.transform, 'translate(0px, 0px) scale(1)');
    await pointer('pointerup', 2, 150, 356);
    await pointer('pointerup', 1, 100, 356);
    stage.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    await flushPromises();
    assert.ok(preview.image, 'pinch к исходному масштабу не закрывает окно');

    await pointer('pointerdown', 3, 10, 60);
    await pointer('pointerup', 3, 10, 60);
    stage.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    await flushPromises();
    assert.equal(preview.visible, false);
  });

  await t.test('колесо имеет предел, а видео сохраняет стандартную обработку', async () => {
    await open();

    for (let index = 0; index < 10; index += 1) {
      const event = new browser.WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });

      // WheelEvent в happy-dom не наследует координаты MouseEvent, в Chromium они есть.
      Object.assign(event, { clientX: 200, clientY: 356 });
      stage.dispatchEvent(event);
    }

    await flushPromises();
    assert.equal(image.style.transform, 'translate(0px, 0px) scale(8)');
    preview.showVideo({ src: '/api/test/video.mp4', name: 'video.mp4' });
    await flushPromises();

    const wheel = new browser.WheelEvent('wheel', { bubbles: true, cancelable: true });

    stage.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, false);
    assert.equal(stage.dataset.image, 'false');
    assert.equal(stage.querySelector('img'), null);
    assert.ok(stage.querySelector('video'));
  });
});
