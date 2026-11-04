import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserEvents } from '../../desktop/src/browser/browserEvents.ts';
import { createBrowserApi } from '../../desktop/src/browser/browserApi.ts';

const disposedMessage = 'Render frame was disposed before WebFrameMain could be accessed';

/**
 * Окно, renderer и frame теряются независимо, как при падении Chromium.
 * Чтение URL и отправка могут отказать уже после успешных проверок состояния.
 */
function fixture() {
  const sent = [];
  const state = {
    windowDead: false,
    contentsDead: false,
    crashed: false,
    loading: false,
    frameDead: false,
    detached: false,
    stopping: false,
    origin: 'http://pipe.test',
    url: 'http://pipe.test/#/chats',
    readError: null,
    sendError: null,
  };
  const frame = {
    isDestroyed: () => state.frameDead,
    get detached() {
      return state.detached;
    },
    get url() {
      if (state.readError) {
        throw state.readError;
      }

      return state.url;
    },
    send(channel, value) {
      if (state.sendError) {
        throw state.sendError;
      }

      sent.push({
        frame: this,
        channel,
        value,
      });
    },
  };
  const contents = {
    isDestroyed: () => state.contentsDead,
    isCrashed: () => state.crashed,
    isLoadingMainFrame: () => state.loading,
    mainFrame: frame,
    send() {
      assert.fail('Отправка должна принадлежать проверенному frame');
    },
  };
  const window = { isDestroyed: () => state.windowDead, webContents: contents };
  const events = createBrowserEvents({
    window: () => window,
    origin: () => state.origin,
    stopping: () => state.stopping,
  });

  return {
    events,
    sent,
    state,
    frame,
    contents,
  };
}

test('browser state и intent получают только проверенный главный frame', () => {
  const f = fixture();
  const snapshot = { revision: 3, tabs: [] };

  f.events.changed(snapshot);
  f.events.intent('address');
  assert.deepEqual(f.sent, [
    {
      frame: f.frame,
      channel: 'grigdesk:browser:state',
      value: snapshot,
    },
    {
      frame: f.frame,
      channel: 'grigdesk:browser:intent',
      value: 'address',
    },
  ]);
});

test('поздние события пропускают окно, contents, renderer и frame на разных стадиях потери', () => {
  for (const key of ['windowDead', 'contentsDead', 'crashed', 'loading', 'frameDead',
    'detached', 'stopping']) {
    const f = fixture();

    f.state[key] = true;
    f.state.readError = new Error(disposedMessage);
    assert.doesNotThrow(() => f.events.changed({ revision: 4 }), key);
    assert.doesNotThrow(() => f.events.intent('close'), key);
    assert.deepEqual(f.sent, [], key);
  }
});

test('недоступный URL, getter mainFrame и IPC при разрушении не бросают исключение', () => {
  for (const stage of ['url', 'mainFrame', 'send']) {
    for (const message of [disposedMessage, 'Object has been destroyed']) {
      const f = fixture();
      const error = new Error(message);

      if (stage === 'url') {
        f.state.readError = error;
      } else if (stage === 'send') {
        f.state.sendError = error;
      } else {
        Object.defineProperty(f.contents, 'mainFrame', { get() {
          throw error;
        } });
      }

      assert.doesNotThrow(() => f.events.changed({}));
      assert.doesNotThrow(() => f.events.intent('new'));
      assert.deepEqual(f.sent, []);
    }
  }
});

test('ошибка данных или программирования остаётся наблюдаемой', () => {
  for (const stage of ['readError', 'sendError']) {
    const f = fixture();
    const error = new Error('Не удалось сериализовать данные');

    f.state[stage] = error;
    assert.throws(() => f.events.changed({}), (actual) => actual === error);
  }
});

test('чужой origin, отсутствующий или сменившийся frame не получает событий', () => {
  for (const change of ['foreign', 'origin', 'missing', 'swapped']) {
    const f = fixture();

    if (change === 'foreign') {
      f.state.url = 'https://foreign.test/';
    } else if (change === 'origin') {
      f.state.origin = 'http://another-pipe.test';
    } else if (change === 'missing') {
      f.contents.mainFrame = null;
    } else {
      let reads = 0;

      Object.defineProperty(f.contents, 'mainFrame', { get() {
        reads += 1;

        return reads === 1 ? f.frame : { ...f.frame };
      } });
    }

    f.events.changed({});
    f.events.intent('forward');
    assert.deepEqual(f.sent, [], change);
  }
});

test('настоящий browser runtime сохраняет metadata и подписчиков после потери UI', async (t) => {
  const f = fixture();
  let guest;
  let updates = 0;
  const api = createBrowserApi({
    preferences: () => ({
      open: 'internal',
      external: 'system',
      agents: false,
      search: 'yandex',
    }),
    commit: async () => {},
    apps: async () => [],
    chooseApp: async () => null,
    external: async () => {},
    bounds: () => ({
      width: 800,
      height: 600,
      zoom: 1,
    }),
    ...f.events,
    view: ({ events }) => {
      guest = events;

      return {
        state: () => ({
          canBack: false,
          canForward: false,
          zoom: 100,
        }),
        navigate: async (url) => events.navigated(url),
        hide() {},
        destroy() {},
      };
    },
  });

  t.after(() => api.dispose());
  api.subscribe(() => {
    updates += 1;
  });
  await api.invoke({
    operation: 'open',
    url: 'https://example.test/',
    target: 'internal',
  });
  f.sent.length = 0;
  updates = 0;
  f.state.readError = new Error(disposedMessage);
  assert.doesNotThrow(() => guest.metadata({ loading: true }));
  assert.equal(api.snapshot().tabs[0].loading, true);
  assert.ok(updates > 0, 'Потеря UI не прерывает остальных подписчиков runtime');
  assert.deepEqual(f.sent, []);

  f.state.readError = null;
  f.contents.mainFrame = { ...f.frame };
  guest.metadata({ loading: false });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].frame, f.contents.mainFrame);
  assert.equal(f.sent[0].value.tabs[0].loading, false);
});
