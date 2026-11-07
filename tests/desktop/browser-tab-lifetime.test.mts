import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createBrowserTabs } from '../../desktop/src/browser/browserTabs.ts';

const FIVE_MINUTES = 300_000;
const rect = {
  x: 0,
  y: 0,
  width: 800,
  height: 600,
};

/**
 * Настоящий реестр использует управляемые часы и лёгкие native views.
 * Уничтожение проверяется отдельно от публичного списка, без ожидания реальных минут.
 */
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });

  let serial = 0;
  let navigation: Promise<void> | null = null;
  const destroyed: string[] = [];
  const tabs = createBrowserTabs({
    id: () => `tab-${++serial}`,
    create: (id) => ({
      navigate: async () => {
        await navigation;
      },
      show: () => {},
      hide: () => {},
      destroy: () => {
        destroyed.push(id);
      },
    }),
  });

  t.after(() => tabs.dispose());

  return {
    tabs,
    destroyed,
    navigation: (pending: Promise<void>) => {
      navigation = pending;
    },
  };
}

test('Через пять минут закрываются агентские вкладки, человеческие сохраняются с grant и без', async (t) => {
  const { tabs, destroyed } = fixture(t);
  const human = await tabs.open('https://fixture.test/human', null);
  const granted = await tabs.open('https://fixture.test/granted', null);
  const agent = await tabs.open('https://fixture.test/agent', 'owner-a');
  const other = await tabs.open('https://fixture.test/other', 'owner-b');

  tabs.grant(granted.id, 'owner-a');
  t.mock.timers.tick(FIVE_MINUTES - 1);
  assert.equal(tabs.list().length, 4);
  t.mock.timers.tick(1);
  assert.deepEqual(tabs.list().map((tab) => tab.id), [human.id, granted.id]);
  assert.deepEqual(destroyed, [agent.id, other.id]);
  assert.equal(tabs.activeId(), human.id);
});

test('Повторный open обновляет срок, фоновые события и чтение списка его не продлевают', async (t) => {
  const { tabs } = fixture(t);
  const tab = await tabs.open('https://fixture.test/', 'owner-a');

  t.mock.timers.tick(240_000);
  assert.equal((await tabs.open(tab.url, tab.owner)).id, tab.id);
  t.mock.timers.tick(240_000);
  tabs.metadata(tab.id, { title: 'Фоновое обновление' });
  tabs.beginNavigation(tab.id);
  tabs.navigated(tab.id, tab.url);
  tabs.list();
  assert.equal(tabs.list().length, 1);
  t.mock.timers.tick(60_000);
  assert.deepEqual(tabs.list(), []);
});

test('Незавершённая команда удерживает вкладку и начинает новый срок после освобождения', async (t) => {
  const { tabs } = fixture(t);
  const tab = await tabs.open('https://fixture.test/', 'owner-a');

  t.mock.timers.tick(240_000);

  const release = tabs.use(tab.id);

  t.mock.timers.tick(FIVE_MINUTES);
  assert.equal(tabs.list().length, 1);
  release();
  release();
  t.mock.timers.tick(FIVE_MINUTES - 1);
  assert.equal(tabs.list().length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(tabs.list(), []);
});

test('Показанная вкладка сохраняется, после скрытия начинается полный срок простоя', async (t) => {
  const { tabs } = fixture(t);
  const tab = await tabs.open('https://fixture.test/', 'owner-a');

  tabs.layout(rect);
  t.mock.timers.tick(FIVE_MINUTES * 2);
  assert.equal(tabs.get(tab.id).id, tab.id);
  tabs.layout(null);
  t.mock.timers.tick(FIVE_MINUTES - 1);
  assert.equal(tabs.list().length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(tabs.list(), []);
});

test('Пауза, отзыв и переподключение host не удерживают заброшенные вкладки', async (t) => {
  const { tabs } = fixture(t);
  const paused = await tabs.open('https://fixture.test/paused', 'owner-a');
  const revoked = await tabs.open('https://fixture.test/revoked', 'owner-a');
  const reconnect = await tabs.open('https://fixture.test/reconnect', 'owner-b');

  t.mock.timers.tick(240_000);
  tabs.pause(paused.id, true);
  tabs.revoke(revoked.id);
  tabs.revoke(reconnect.id, true);
  t.mock.timers.tick(60_000);
  assert.deepEqual(tabs.list(), []);
});

test('Незавершённое открытие не очищается до завершения navigate', async (t) => {
  const f = fixture(t);
  let finish = () => {};

  f.navigation(new Promise<void>((resolve) => {
    finish = resolve;
  }));

  const pending = f.tabs.open('https://fixture.test/', 'owner-a');
  const release = f.tabs.use(f.tabs.list()[0]!.id);

  t.mock.timers.tick(FIVE_MINUTES * 2);
  assert.equal(f.tabs.list().length, 1);
  finish();

  const tab = await pending;

  assert.equal(f.tabs.get(tab.id).navigating, false);
  t.mock.timers.tick(FIVE_MINUTES);
  assert.equal(f.tabs.list().length, 1);
  release();
  t.mock.timers.tick(FIVE_MINUTES - 1);
  assert.equal(f.tabs.list().length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(f.tabs.list(), []);
});

test('Закрытие и dispose снимают таймеры, повторное использование реестра создаёт новые', async (t) => {
  const { tabs, destroyed } = fixture(t);
  const tab = await tabs.open('https://fixture.test/', 'owner-a');
  const release = tabs.use(tab.id);

  tabs.close(tab.id);
  release();
  await tabs.open('https://fixture.test/second', 'owner-b');
  tabs.dispose();
  t.mock.timers.tick(FIVE_MINUTES);
  assert.equal(destroyed.length, 2);
  await tabs.open('https://fixture.test/third', 'owner-a');
  t.mock.timers.tick(FIVE_MINUTES);
  assert.equal(destroyed.length, 3);
  assert.deepEqual(tabs.list(), []);
});
