import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import { createKeyboardLayoutReader } from '../../desktop/src/keyboardLayout.ts';
import { createShellApi } from '../../desktop/src/pipe/shellApi.ts';

const X11 = { platform: 'linux', env: { DISPLAY: ':test', XDG_SESSION_TYPE: 'x11' } };

test('раскладка меняется без ввода; запросы объединяются, ошибка не оставляет старое значение', async () => {
  let clock = 0;
  let calls = 0;
  let value = { code: 'us', variant: '' };
  const read = createKeyboardLayoutReader({
    ...X11,
    now: () => clock,
    query: async () => {
      calls += 1;

      return JSON.stringify(value);
    },
  });

  assert.deepEqual(await Promise.all([read(), read()]), [value, value]);
  assert.equal(calls, 1);
  value = { code: 'ru', variant: 'phonetic' };
  clock = 249;
  assert.equal((await read()).code, 'us');
  clock = 250;
  assert.deepEqual(await read(), value);
  assert.equal(calls, 2);
  value = { code: '<invalid>', variant: '' };
  clock = 500;
  assert.equal(await read(), null);
  value = { code: 'de', variant: '' };
  clock = 5499;
  assert.equal(await read(), null);
  clock = 5500;
  assert.deepEqual(await read(), value);
});

test('нет Python, повреждённый JSON и синхронный отказ дают неизвестную раскладку', async () => {
  const queries = [
    async () => {
      throw new Error('ENOENT');
    },
    async () => 'invalid-json',
    () => {
      throw new Error('unavailable');
    },
  ];

  for (const query of queries) {
    const read = createKeyboardLayoutReader({ ...X11, query });

    assert.equal(await read(), null);
    assert.equal(await read(), null);
  }
});

test('Wayland, другая ОС и отсутствующий DISPLAY не опрашивают Xwayland или чужую клавиатуру', async () => {
  for (const options of [
    { platform: 'win32', env: { DISPLAY: ':test' } },
    { platform: 'linux', env: {} },
    { ...X11, env: { ...X11.env, XDG_SESSION_TYPE: 'wayland' } },
    { ...X11, env: { ...X11.env, WAYLAND_DISPLAY: 'wayland-test' } },
  ]) {
    let calls = 0;
    const read = createKeyboardLayoutReader({
      ...options,
      query: async () => {
        calls += 1;

        return '{}';
      },
    });

    assert.equal(await read(), null);
    assert.equal(calls, 0);
  }
});

test('маршрут оболочки читает локальную раскладку без обращения к выбранному серверу', async () => {
  for (const layout of [{ code: 'ru', variant: '' }, null]) {
    const shell = createShellApi({
      keyboardLayout: async () => layout,
      profiles: { settings: { profiles: [] } },
    });
    const request = Readable.from([]);
    let status;
    let body;

    request.method = 'GET';
    request.url = '/__shell/keyboard-layout';
    await shell.handle(request, {
      writeHead(value) {
        status = value;
      },
      end(value) {
        body = JSON.parse(value);
      },
    });
    shell.close();
    assert.equal(status, 200);
    assert.deepEqual(body, { layout });
  }
});
