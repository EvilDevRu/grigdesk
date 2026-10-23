import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { Readable } from 'node:stream';
import { normalizeSettings } from '../../desktop/src/settings.ts';
import { Profiles } from '../../desktop/src/profiles.ts';
import { createShellApi } from '../../desktop/src/pipe/shellApi.ts';

test('PB-LOCAL-02: активация ELF предшествует commit, private-путь не попадает в JSON', async (t) => {
  for (const refused of [false, true]) {
    const title = refused ? 'отказ сохраняет прежний выбор' : 'успех меняет выбор после активации';

    await t.test(title, async (t) => {
      const settings = normalizeSettings({
        version: 1,
        connection: { kind: 'local', origin: 'http://127.0.0.1:12345' },
      });
      const previous = settings.selected;
      const profiles = new Profiles({
        settings,
        save: async () => {},
        available: async () => true,
      });
      const candidate = {
        ...settings.profiles[0],
        id: 'portable-candidate',
        port: 47102,
        name: 'Соседняя установка',
        serverBinary: '/private/portable/bin/grigdesk-server',
      };
      const events = [];
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });

      settings.profiles.push(candidate);

      const shell = createShellApi({
        profiles,
        pairing: { addByPairing: async () => candidate },
        localAvailable: () => true,
        localAddress: () => candidate.address,
        navigate: async () => {
          events.push('navigate');
        },
        /**
         * Удерживает активацию до явного разрешения теста.
         * Отказ должен сохранить прежний транспорт и выбранный профиль.
         */
        async beforeSelect(profile) {
          assert.equal(profile.serverBinary, candidate.serverBinary);
          events.push('activate');
          await gate;

          if (refused) {
            throw new Error('Проверка соседнего ELF отклонена');
          }

          events.push('activated');
        },
        upstream(_profile, report) {
          return {
            request() {},
            upgrade() {},
            close() {
              events.push('disconnect');
            },
            async probe() {
              report({
                status: 'online',
                detail: null,
                serverApi: null,
              });
            },
          };
        },
      });
      const server = http.createServer((req, res) => shell.handle(req, res));

      await shell.connect();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(async () => {
        release();
        shell.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });

      const origin = `http://127.0.0.1:${server.address().port}`;
      const selection = fetch(`${origin}/__shell/select`, {
        method: 'POST',
        body: JSON.stringify({ id: candidate.id }),
      });

      try {
        // Запрос проходит настоящий HTTP-router; очередь ограничена сроком теста.
        for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }

        assert.deepEqual(events, ['activate']);
        assert.equal(settings.selected, previous);
      } finally {
        release();
        await selection;
      }

      const response = await selection;

      assert.equal(response.ok, !refused);
      assert.equal(settings.selected, refused ? previous : candidate.id);

      if (!refused) {
        assert.ok(events.indexOf('activated') < events.indexOf('disconnect'));
      }

      const publicJson = await (await fetch(`${origin}/__shell/profiles`)).text();

      assert.doesNotMatch(publicJson, /serverBinary|\/private\//u);
      assert.doesNotMatch(JSON.stringify(shell.state()), /serverBinary|\/private\//u);
    });
  }
});

/**
 * Время повторов управляется очередью, а транспорт даёт явные состояния без сети.
 * Никакие таймеры и случайные порты этой проверки не относятся к живому GrigDesk.
 */
function fixture(overrides = {}) {
  const settings = normalizeSettings({
    version: 1,
    connection: { kind: 'local', origin: 'http://127.0.0.1:12345' },
  });
  const profiles = new Profiles({
    settings,
    save: async () => {},
    available: async () => true,
  });
  const timers = [];
  let report;
  let available = true;
  let terminal = 'offline';
  let probes = 0;
  let paired;
  const addresses = [];
  const shell = createShellApi({
    ...overrides,
    profiles,
    pairing: { addByPairing: async () => paired },
    localAvailable: () => available,
    localAddress: () => 'http://127.0.0.1:12345',
    navigate: async () => {},
    random: () => 0.5,
    schedule(callback, delay) {
      const timer = {
        callback,
        delay,
        cancelled: false,
      };

      timers.push(timer);

      return () => {
        timer.cancelled = true;
      };
    },
    upstream(_profile, onState) {
      addresses.push(_profile.address);
      report = onState;

      return {
        request() {},
        upgrade() {},
        close() {},
        async probe() {
          probes += 1;
          onState({
            status: terminal,
            detail: null,
            serverApi: null,
          });
        },
      };
    },
  });

  return {
    shell,
    settings,
    addresses,
    paired(profile) {
      paired = profile;
    },
    timers,
    report: (status) => report({
      status,
      detail: null,
      serverApi: null,
    }),
    unavailable() {
      available = false;
    },
    terminal(status) {
      terminal = status;
    },
    probes: () => probes,
  };
}

test('оболочка проверяет localAvailable, повторяет offline по R14 и останавливает disconnect', async () => {
  const value = fixture();

  assert.equal(value.shell.state().localAvailable, true);
  await value.shell.connect();

  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const timer = value.timers.at(-1);

    assert.equal(timer.delay, delay);
    await timer.callback();
  }

  const before = value.probes();

  value.shell.disconnect();
  assert.equal(value.timers.at(-1).cancelled, true);
  await value.timers.at(-1).callback();
  assert.equal(value.probes(), before);
  value.unavailable();
  assert.equal(value.shell.state().localAvailable, false);
  value.shell.close();
});

test('терминальные состояния без повторов; long-poll получает изменение и таймаут', async (t) => {
  const value = fixture();

  value.terminal('revoked');
  await value.shell.connect();
  assert.equal(value.timers.length, 0);
  assert.equal(value.shell.state().status, 'revoked');

  const server = http.createServer((req, res) => value.shell.handle(req, res));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    value.shell.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = value.shell.state();
  const pending = fetch(`${origin}/__shell/state?rev=${state.rev}`);

  await new Promise((resolve) => setTimeout(resolve, 30));
  value.report('identityMismatch');
  assert.equal((await (await pending).json()).status, 'identityMismatch');

  const timeout = fetch(`${origin}/__shell/state?rev=${value.shell.state().rev}`);

  await new Promise((resolve) => setTimeout(resolve, 30));
  value.timers.at(-1).callback();
  assert.equal((await (await timeout).json()).status, 'identityMismatch');

  const remove = await fetch(`${origin}/__shell/profiles/${value.settings.selected}`, { method: 'DELETE' });

  assert.equal(remove.status, 200);
  assert.equal(value.shell.state().profile, null);
  assert.equal(value.settings.selected, null);
});

test('фоновая готовность supervisor не отменяет disconnect и терминальную причину', async () => {
  const value = fixture();

  await value.shell.connect();
  value.shell.disconnect();

  const disconnected = value.probes();

  await value.shell.connect(value.settings.selected, false);
  assert.equal(value.probes(), disconnected);
  value.terminal('incompatible');
  await value.shell.connect();

  const incompatible = value.probes();

  await value.shell.connect(value.settings.selected, false);
  assert.equal(value.probes(), incompatible);
  assert.equal(value.shell.state().status, 'incompatible');
  value.shell.close();
});

test('D4: выбор текущей машины сохраняет транспорт и документ', async (t) => {
  const value = fixture();

  value.terminal('online');
  await value.shell.connect();

  const probes = value.probes();
  const rev = value.shell.state().rev;
  const server = http.createServer((req, res) => value.shell.handle(req, res));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    value.shell.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/__shell/select`, {
    method: 'POST', body: JSON.stringify({ id: value.settings.selected }),
  });

  assert.equal(response.status, 200);
  assert.equal(value.probes(), probes);
  assert.equal(value.shell.state().rev, rev);
});

test('W9: повтор сообщает срок, ручное отключение отличается от обрыва', async () => {
  const value = fixture();
  const before = Date.now();

  await value.shell.connect();

  const state = value.shell.state();

  assert.ok(state.detail?.retryAt >= before + 900);
  assert.ok(state.detail?.retryAt <= Date.now() + 1100);
  value.shell.disconnect();
  assert.equal(value.shell.state().detail?.code, 'disconnected');
  value.shell.close();
});


test('R4: повторная привязка текущего профиля переключает транспорт на новый адрес', async (t) => {
  const value = fixture();
  const server = http.createServer((req, res) => value.shell.handle(req, res));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    value.shell.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await value.shell.connect();

  const current = value.settings.profiles[0];

  current.address = 'http://127.0.0.1:23456';
  value.paired(current);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/__shell/profiles`, {
    method: 'POST',
    body: JSON.stringify({ pairing: 'synthetic' }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(value.addresses, ['http://127.0.0.1:12345', 'http://127.0.0.1:23456']);
});

/**
 * Проверка shell-ветки не подменяет pipe security: он уже покрыт соседним файлом.
 * Поток тела и JSON-ответ остаются реальными контрактами Node HTTP.
 */
async function invokeSurface(shell, path, body) {
  const request = Readable.from([JSON.stringify(body)]);

  request.method = 'POST';
  request.url = path;
  request.headers = { host: '127.0.0.1:47101' };

  let status;
  let result;
  const response = {
    headersSent: false,
    writeHead(value) {
      status = value;
      this.headersSent = true;
    },
    end(value) {
      result = JSON.parse(value);
    },
  };

  await shell.handle(request, response);

  return { status, result };
}

test('SA-01: capability и закрытые действия поверхностей', async (t) => {
  const calls = [];
  let opened = true;
  const f = fixture({
    nativeWindows: {
      async open(origin, target) {
        calls.push({ origin, target });

        return opened;
      },
      async main(origin, destination) {
        calls.push({ origin, destination });

        return opened;
      },
    },
  });

  t.after(() => f.shell.close());
  assert.deepEqual(f.shell.state().capabilities, ['windows']);
  assert.deepEqual(await invokeSurface(f.shell, '/__shell/surfaces/open', {
    kind: 'task', id: '42',
  }), { status: 200, result: { opened: true } });
  assert.deepEqual(calls[0], {
    origin: 'http://127.0.0.1:47101', target: { kind: 'task', id: '42' },
  });
  assert.equal((await invokeSurface(f.shell, '/__shell/surfaces/main', {
    destination: 'pipeline',
  })).result.opened, true);
  assert.equal((await invokeSurface(f.shell, '/__shell/surfaces/main', {
    destination: 'task-dialog', target: { kind: 'task', id: '43' },
  })).result.opened, true);

  for (const body of [
    {
      kind: 'task', 
      id: '42', 
      url: 'https://example.org'
    },
    { kind: 'code', id: '42' }, { kind: 'task', id: '../42' },
    {
      kind: 'task',
      id: '42',
      options: {},
    },
    { kind: 'task', id: 42 },
  ]) {
    assert.equal((await invokeSurface(f.shell, '/__shell/surfaces/open', body)).status, 400);
  }

  assert.equal((await invokeSurface(f.shell, '/__shell/surfaces/main', {
    destination: 'pipeline', script: 'arbitrary',
  })).status, 400);
  assert.equal((await invokeSurface(f.shell, '/__shell/surfaces/main', {
    destination: 'unknown',
  })).status, 400);
  assert.equal(calls.length, 3);
  opened = false;
  assert.deepEqual(await invokeSurface(f.shell, '/__shell/surfaces/open', {
    kind: 'task', id: '44',
  }), { status: 200, result: { opened: false } });
  f.shell.close();
});
test('SA-02: без адаптера новая возможность отсутствует', async () => {
  const f = fixture();

  assert.deepEqual(f.shell.state().capabilities, []);
  assert.equal((await invokeSurface(f.shell, '/__shell/surfaces/open', {
    kind: 'task', id: '42',
  })).status, 404);
  f.shell.close();
});

test('TW-N03b: старый surfaces/open отвергает tool и tool+instance без вызова native', async (t) => {
  const calls = [];
  const f = fixture({
    nativeWindows: {
      open: async (...args) => {
        calls.push(args);

        return true;
      },
      main: async () => true,
    }
  });

  t.after(() => f.shell.close());

  for(const body of [
    { kind: 'tool', id: 'code' },
    {
      kind: 'tool',
      id: 'code',
      instance: 'tool-instance-aaaaaaaa'


    },
  ]) {
    const response = await invokeSurface(f.shell, '/__shell/surfaces/open', body);

    assert.equal(response.status, 400);
    assert.equal(response.result.error, 'invalid_surface');
  }

  assert.deepEqual(calls, []);
});

test('TW-N03: отдельный tool control, точная форма и неизвестная instance', async (t) => {
  const calls = [];
  const instance = 'tool-instance-aaaaaaaa';
  const f = fixture({
    nativeWindows: {

      open: async () => true,

      main: async () => true,

      async tool(origin, request) {
        calls.push({ origin, request });

        return request.action === 'open'
          ? { opened: true, instance }
          : { closed: request.instance === instance };
      },



    }
  });

  t.after(() => f.shell.close());

  const opening = await invokeSurface(f.shell, '/__shell/surfaces/tool', { action: 'open', id: 'code' });

  assert.equal(opening.status, 200, 'В защищённой трубе отсутствует управление tool windows');
  assert.deepEqual(opening.result, { opened: true, instance });
  assert.equal((await invokeSurface(f.shell, '/__shell/surfaces/tool', {

    action: 'close',
    id: 'code',
    instance: 'stale-instance',



  })).result.closed, false);

  for(const body of [
    { action: 'open', id: 'terminal' },
    {
      action: 'open',
      id: 'code',
      url: 'https://example.org'


    },
    { action: 'close', id: 'code' },
    { action: 'execute', id: 'code' },
  ]) {
    assert.equal((await invokeSurface(f.shell, '/__shell/surfaces/tool', body)).status, 400);
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].origin, 'http://127.0.0.1:47101');

  const noNative = fixture();

  t.after(() => noNative.shell.close());
  assert.equal((await invokeSurface(noNative.shell, '/__shell/surfaces/tool', {
    action: 'open', id: 'code',
  })).status, 404);
});

for (const code of ['server_start_failed', 'server_start_timeout']) {
  test(`SH-START-REASON: ${code} сохраняет причину и рабочий повтор`, async (t) => {
    const value = fixture();

    t.after(() => value.shell.close());
    await value.shell.connect();
    value.report('online');
    value.report('connecting');

    const detail = { code, message: 'Синтетическая причина местного запуска' };
    const snapshot = {
      status: 'offline',
      detail,
      serverApi: null,
    };
    const before = Date.now();

    if (code === 'server_start_failed') {
      value.shell.reportBackground(value.settings.selected, snapshot);
    } else {
      value.shell.report(value.settings.selected, snapshot);
    }

    const reported = value.shell.state().detail;

    assert.equal(reported.code, code, 'Назначение повтора сохраняет причину запуска.');
    assert.equal(reported.message, detail.message);
    assert.ok(reported.retryAt >= before + 900);
    assert.ok(reported.retryAt <= Date.now() + 1100);

    const probes = value.probes();

    await value.timers.at(-1).callback();
    assert.equal(value.probes(), probes + 1, 'Повтор действительно проверяет сервер.');
    assert.equal(value.shell.state().detail.code, 'retry_wait', 'Обычный offline сохраняет политику.');
  });
}

test('SH-START-REASON: срок через report не меняет уже готовый online', async (t) => {
  const value = fixture();

  t.after(() => value.shell.close());
  value.terminal('online');
  await value.shell.connect();

  const before = value.shell.state();

  value.shell.report(value.settings.selected, {
    status: before.status,
    detail: { code: 'server_start_timeout', message: 'Поздний срок' },
    serverApi: before.serverApi,
  });
  assert.deepEqual(value.shell.state(), before);
  assert.equal(value.timers.length, 0);
});
