import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NOTIFY_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/notify.ts', import.meta.url),
)).href;
let fixtureId = 0;

async function fixture(t, { permission = 'granted', registration = null } = {}) {
  const constructed = [];
  class FakeNotification {
    static permission = permission;

    static async requestPermission() {
      FakeNotification.permission = 'granted';
      return 'granted';
    }

    constructor(title, options) {
      constructed.push({
        title,
        options,
        instance: this,
      });
      this.closed = 0;
    }

    close() {
      this.closed += 1;
    }
  }

  const window = {
    Notification: FakeNotification,
    location: { href: 'https://grigdesk.test/#/chats' },
    focus() {},
  };
  const document = { hidden: false, title: 'GrigDesk' };
  const navigator = registration
    ? { serviceWorker: { async getRegistration() { return registration; } } }
    : {};
  for (const [key, value] of Object.entries({ window, document, navigator })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const key of ['window', 'document', 'navigator']) delete globalThis[key];
  });

  const api = await import(`${NOTIFY_URL}?device-notify-test=${fixtureId += 1}`);
  return { api, FakeNotification, constructed };
}

test('уведомление использует Notification и встроенную иконку даже при старой регистрации', async (t) => {
  const shown = [];
  const registration = {
    async showNotification(title, options) {
      shown.push({ title, options });
    },
  };
  const { api, constructed } = await fixture(t, { registration });

  assert.equal(await api.notify('Агент ответил', 'Готово', 'chat-1'), true);
  assert.equal(shown.length, 0);
  assert.equal(constructed.length, 1);
  assert.match(constructed[0].options.icon, /^data:image\/png;base64,/);
  assert.equal(constructed[0].options.data.url, 'https://grigdesk.test/#/chats');
});

test('десктоп без service worker использует обычный Notification', async (t) => {
  const { api, constructed } = await fixture(t);

  assert.equal(await api.notify('Проверка', 'Текст'), true);
  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].title, 'Проверка');
});

test('разрешение запрашивается только явным вызовом', async (t) => {
  const { api, FakeNotification } = await fixture(t, { permission: 'default' });

  assert.equal(await api.ensureNotifyPermission(), true);
  assert.equal(FakeNotification.permission, 'granted');
});

test('N1: уведомление без serviceWorker получает ссылку нужного чата', async (t) => {
  const { api, constructed } = await fixture(t);
  const url = 'https://grigdesk.test/#/chats?openChat=c1';

  await api.notify('t', 'b', 'chat-1', url);
  assert.equal(constructed[0].options.data.url, url);
});

test('N2: щелчок по обычному уведомлению открывает адрес и закрывает его', async (t) => {
  const { api, constructed } = await fixture(t);
  const url = 'https://grigdesk.test/#/chats?openChat=c1';

  await api.notify('t', 'b', 'chat-1', url);
  constructed[0].instance.onclick();
  assert.equal(globalThis.window.location.href, url);
  assert.equal(constructed[0].instance.closed, 1);
});

test('N3: закрытие по tag находит экземпляр конструктора', async (t) => {
  const { api, constructed } = await fixture(t);

  await api.notify('t', 'b', 'chat-1');
  await api.closeSystemNotification('chat-1');
  assert.equal(constructed[0].instance.closed, 1);
});
