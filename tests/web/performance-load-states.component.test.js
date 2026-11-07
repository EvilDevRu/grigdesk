import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';
import { mountLoadingPipeline } from './fixtures/loading/pipeline.mjs';
import { measured } from './helpers/performance-surface.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('PipelineView: исходный отказ даёт error, повтор с пустым успехом — ready нового span',
  async (t) => {
    const h = await mountLoadingPipeline(t);
    const f = measured(t, h.wrapper, 'pipeline', 'route');

    await f.paint();
    assert.equal(f.log.snapshot().entries.some((row) => row.data.phase === 'ready'), false);
    h.pending.reject(new Error('fixture failure'));
    await h.flush();
    await f.paint();

    const failure = f.log.snapshot().entries.at(-1).data;

    assert.equal(failure.phase, 'error');
    h.reset();

    const retry = h.wrapper.vm.load();

    await h.flush();
    await f.paint();
    assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'start');
    await h.resolve();
    await retry;
    await f.paint();
    assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'ready');
    assert.notEqual(f.log.snapshot().entries.at(-1).data.surface, failure.surface);
  });

for (const [page, component, endpoint] of [
  ['automation.chats', 'PreferencesPage', '/api/settings/prefs'],
  ['speech.dictation', 'SpeechPage', '/api/settings/speech'],
  ['system.diagnostics', 'DiagnosticsPage', '/api/settings/factory-debug?scope=global'],
]) {
  test(`${component}: обычный отказ первого API получает error`, async (t) => {
    const h = await settingsHarness(t, page, component, {
      prepare({ control }) {
        control.handlers[endpoint] = () => Response.json({ error: 'fixture' }, { status: 503 });
      },
    });
    const f = measured(t, h.wrapper, page);

    await f.paint();
    assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'error');
  });
}

for (const outcome of ['success', 'error']) {
  test(`ProcessesPage: первый error, повтор с удержанным ответом → ${outcome}`, async (t) => {
    const h = await settingsHarness(t, 'system.processes', 'ProcessesPage', {
      prepare({ control }) {
        control.handlers['/api/chat/sessions'] = () => Response.json({ error: 'fixture' }, { status: 503 });
      },
    });
    const f = measured(t, h.wrapper, 'system.processes');

    await f.paint();

    const old = f.log.snapshot().entries.at(-1).data;
    const waiting = Promise.withResolvers();

    assert.equal(old.phase, 'error');
    h.control.handlers['/api/chat/sessions'] = () => waiting.promise;
    h.module.setUiLocale('ru');
    await h.flushPromises();

    const refresh = h.wrapper.findAll('button').find((button) => button.text() === 'Обновить');

    assert.ok(refresh);
    await refresh.trigger('click');
    await f.paint();
    assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'start');
    waiting.resolve(outcome === 'success' ? Response.json({
      sessions: [],
      maxSessions: 4,
      idleMs: 60_000,
    }) : Response.json({ error: 'fixture retry' }, { status: 503 }));
    await h.flushPromises();
    await f.paint();

    const last = f.log.snapshot().entries.at(-1).data;

    assert.equal(last.phase, outcome === 'success' ? 'ready' : 'error');
    assert.notEqual(last.surface, old.surface);
  });
}

test('ProjectList: ошибка обновления над пригодным списком остаётся ready', async (t) => {
  await installUiBrowser(t);

  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const List = await compileVue(webFile('src/views/projects/ProjectList.vue'));
  const wrapper = mount(List, {
    attachTo: document.querySelector('#mount'),
    props: {
      items: [{
        id: 'p1',
        title: 'Проект',
        repos: [],
        warnings: [],
        archivedAt: null
      }],
      loading: false,
      error: 'fixture refresh failure',
    },
  });

  t.after(() => wrapper.unmount());

  const f = measured(t, wrapper, 'projects', 'route');

  await f.paint();
  assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'ready');
});
