import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { studioBrowserFixture } from './helpers/studio3dPluginBackground.js';
import {
  studioIntegrationTest, studioUntil, uploadStudioModel,
} from '../server/helpers/studio3dPluginFixture.js';

/**
 * CSS читается по настоящему публичному URL fixture, затем подтверждается событие DOM.
 * Это проверка host lifecycle в happy-dom, не визуальная WebGL/packaged приёмка.
 */
async function settleMounted(f) {
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    if (!link.dataset.fixtureLoaded) {
      link.dataset.fixtureLoaded = 'true';

      const response = await fetch(link.href);

      assert.equal(response.status, 200);
      await response.text();
      link.dispatchEvent(new f.browser.Event('load'));
    }
  }

  await f.settle();
}

/**
 * Общая оболочка ядра монтирует настоящий default PanelRoot из отдельного графа плагина.
 * Пропсы presentation/active и очередь dock проходят без подмены компонентов продукта.
 */
async function mountModule(t, width, presentation) {
  const f = await studioBrowserFixture(t);

  Object.defineProperty(f.browser, 'innerWidth', { value: width, configurable: true });
  await f.login();
  await f.ready();

  const dock = f.host.docks.useDockStore(f.pinia);
  const props = f.host.vue.reactive({
    active: true,
    compact: width < 900 || presentation === 'dock',
    presentation,
  });
  const component = {
    setup() {
      return () => f.host.vue.h(f.host.modulePanel.default, {
        pluginId: 'studio3d',
        descriptor: f.plugins.byId('studio3d').entrypoints.web,
        label: '3D',
        ...props,
        intents: dock.intents.studio3d ?? [],
        onConsumeIntent: (id) => dock.consume('studio3d', id),
      });
    },
  };
  const element = document.createElement('div');
  const app = f.host.vue.createApp(component);

  document.body.append(element);
  app.use(f.pinia).mount(element);
  t.after(() => {
    app.unmount();
    element.remove();
  });
  await studioUntil(async () => {
    await settleMounted(f);

    return element.querySelector('.studio-panel');
  }, Boolean);

  const context = f.panelContexts.at(-1);
  const session = await f.product.session(context);

  return {
    ...f,
    dock,
    props,
    element,
    app,
    context,
    session,
  };
}

for (const [width, presentation] of [[899, 'page'], [900, 'dock'], [1280, 'page']]) {
  studioIntegrationTest(test, `S3D-HOST ${width}/${presentation}: настоящий Root и черновик при скрытии`,
    async (t) => {
      const f = await mountModule(t, width, presentation);

      await studioUntil(async () => {
        await settleMounted(f);

        return f.element.querySelector('textarea');
      }, Boolean);

      const textarea = f.element.querySelector('textarea');

      textarea.value = 'Черновик настоящей панели';
      textarea.dispatchEvent(new f.browser.Event('input', { bubbles: true }));
      await f.settle();
      f.props.active = false;
      await f.settle();
      assert.equal(f.element.querySelector('textarea'), textarea);
      f.props.active = true;
      f.props.presentation = presentation === 'dock' ? 'page' : 'dock';
      await f.settle();
      assert.equal(f.element.querySelector('textarea'), textarea);
      assert.equal(textarea.value, 'Черновик настоящей панели');
      assert.deepEqual(f.counts(), { panel: 1, background: 1 });
      assert.equal(f.sources.length, 1);
      assert.equal(f.session.context, f.context);
      assert.equal(f.session.store.admitted, true);
      assert.equal(f.session.store.libraryId, f.libraryId);
    }, { timeout: 20000 });
}

studioIntegrationTest(test, 'S3D-HOST generic params открывают настоящую модель/версию и consume dock',
  async (t) => {
    const f = await mountModule(t, 900, 'dock');
    const uploaded = await uploadStudioModel(f);

    assert.equal(uploaded.statusCode, 200, uploaded.body);

    const created = await f.call('POST', '/models', {
      libraryId: f.libraryId,
      uploadId: uploaded.json().uploadId,
      name: 'Модель для команды панели',
    });

    assert.equal(created.statusCode, 200, created.body);

    const result = created.json();

    f.dock.enqueue('studio3d', { type: 'open', params: {
      model: result.model.id,
      version: result.version.id,
    } });
    await studioUntil(async () => {
      await settleMounted(f);

      return f.session.store.detail;
    }, (detail) => detail?.model.id === result.model.id);
    assert.equal(f.session.store.selectedVersion, result.version.id);
    assert.equal(f.element.querySelectorAll('.studio-panel.is-model').length, 1);
    assert.equal(f.dock.intents.studio3d, undefined);
    assert.equal(f.requests.some((row) => row.path === `/api/ext/studio3d/models/${result.model.id}`), true);
    assert.deepEqual(f.counts(), { panel: 1, background: 1 });
  }, { timeout: 20000 });

studioIntegrationTest(test, 'S3D-HOST params настоящего server notification открывают durable версию',
  async (t) => {
    const f = await mountModule(t, 900, 'dock');
    const uploaded = await uploadStudioModel(f);

    assert.equal(uploaded.statusCode, 200, uploaded.body);

    const created = await f.call('POST', '/models', {
      libraryId: f.libraryId,
      uploadId: uploaded.json().uploadId,
      name: 'Модель для уведомления панели',
    });

    assert.equal(created.statusCode, 200, created.body);

    const model = created.json();
    const input = {
      libraryId: f.libraryId,
      provider: 'local',
      operation: 'rotate',
      modelId: model.model.id,
      versionId: model.version.id,
      values: { turn: 'y90' },
    };
    const quote = await f.call('POST', '/quote', input);

    assert.equal(quote.statusCode, 200, quote.body);

    const quoted = quote.json();
    const accepted = await f.call('POST', '/run', {
      ...input,
      idempotencyKey: randomUUID(),
      values: quoted.validation.values,
      expectedPrice: quoted.quote.total,
    });

    assert.equal(accepted.statusCode, 202, accepted.body);
    await f.server.studio3d.context.jobs.tick();
    await f.server.studio3d.context.jobs.settle();

    const items = await f.server.studio3d.notifications(new AbortController().signal);
    const notification = items.find((item) => item.action === 'show');

    assert.ok(notification);
    f.dock.enqueue('studio3d', { type: 'open', params: notification.params });
    await studioUntil(async () => {
      await settleMounted(f);

      return { detail: f.session.store.detail, params: notification.params };
    }, (value) => value.detail?.model.id === model.model.id);
    assert.equal(f.session.store.selectedVersion, accepted.json().versions[0].id);
    assert.equal(f.dock.intents.studio3d, undefined);
    assert.equal(f.fake.requests.filter((row) => row.path.endsWith('/text-to-model')).length, 0);
  }, { timeout: 20000 });
