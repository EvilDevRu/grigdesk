import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hostFixture, detachButton } from './helpers/tool-window-harness.js';

test('TW-B01: dock/page/hidden сохраняют один render-site, 900→899 снимает скрытые панели', async (t) => {
  const f = await hostFixture(t, { width: 900 });

  f.dock.open('code');
  await f.settle();
  assert.equal(f.wrapper.findAll('[data-panel="code"]').length, 1);
  f.dock.close();
  await f.settle();
  assert.equal(f.mounts.filter((id) => id === 'code').length, 1);
  await f.router.push('/code');
  await f.settle();
  assert.equal(f.wrapper.findAll('[data-panel="code"]').length, 1);
  await f.router.push('/chats');
  f.dock.open('terminal');
  await f.settle();
  f.browser.happyDOM.setWindowSize({ width: 899, height: 900 });
  f.browser.dispatchEvent(new f.browser.Event('resize'));
  await f.settle();
  assert.equal(f.wrapper.findAll('[data-panel]').length, 0);
  assert.equal(f.unmounts.includes('terminal'), true);
  f.browser.happyDOM.setWindowSize({ width: 900, height: 900 });
  f.browser.dispatchEvent(new f.browser.Event('resize'));
  await f.settle();
  assert.equal(f.dock.isOpen, false);
  assert.equal(f.wrapper.findAll('[data-panel]').length, 0);
});

test('TW-B02: прежние режимы и исключённые инструменты без кнопки открепления', async (t) => {
  for(const mode of ['page', 'android', 'main']) {
    await t.test(mode, async (t) => {
      const f = await hostFixture(t, { mode, windows: false });

      for(const id of ['code', 'terminal', 'studio3d']) {
        f.dock.open(id);
        await f.settle();
        assert.equal(detachButton(f.wrapper), undefined);
        assert.equal(f.wrapper.findAll(`[data-panel="${id}"]`).length, 1);
      }
    });
  }

  await t.test('terminal и studio3d с windows', async (t) => {
    const f = await hostFixture(t);

    for(const id of ['terminal', 'studio3d']) {
      f.dock.open(id);
      await f.settle();
      assert.equal(detachButton(f.wrapper), undefined);
      assert.equal(f.wrapper.findAll(`[data-panel="${id}"]`).length, 1);
    }

    f.dock.close();
    f.browser.document.dispatchEvent(new f.browser.KeyboardEvent('keydown', {

      code: 'Digit3',
      key: '3',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,

    }));
    await f.settle();
    assert.equal(f.dock.activeTool, 'terminal');
    assert.equal(f.dock.isOpen, true);
  });
});

test('TW-B03: прежние relay события остаются неизменным префиксом', async () => {
  const source = await readFile(new URL('../../web/src/composables/useSse.ts', import.meta.url), 'utf8');
  const block = source.match(/const RELAYED_EVENTS[^=]*=\s*\[([\s\S]*?)\]/);

  assert.ok(block, 'найден действующий список RELAYED_EVENTS');
  assert.deepEqual([...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).slice(0, 4), [
    'hello', 'diagnostic-logging', 'task-shelf-changed', 'speech-settings',
  ]);
});
