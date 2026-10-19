import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { normalizeSettings } from '../../desktop/src/settings.ts';
import { Profiles } from '../../desktop/src/profiles.ts';
import { createShellApi } from '../../desktop/src/pipe/shellApi.ts';

/**
 * Время повторов управляется очередью, а транспорт даёт явные состояния без сети.
 * Никакие таймеры и случайные порты этой проверки не относятся к живому GrigDesk.
 */
function fixture() {
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
