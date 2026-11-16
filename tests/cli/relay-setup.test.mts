import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { parseArgs } from '../../cli/args.ts';
import { relayCliFixture } from './helpers/relayDeployment.mts';
import { assertRestored } from './helpers/pty.mts';

for (const action of ['setup', 'restore']) {
  test(`RD-CTL-01: source ctl разбирает relay ${action} до Docker dispatch`, () => {
    let args: ReturnType<typeof parseArgs>;

    assert.doesNotThrow(() => args = parseArgs(['relay', action]));

    assert.equal(args!.kind, 'relay');
    assert.equal(args!.action, action);
  });
}

test('RD-CTL-01/03: PTY setup, явные host key/preview, QR и отдельное pending телефона', async (t) => {
  const h = await relayCliFixture(t);
  const terminal = h.launch('setup', {
    args: [
      '--ssh-port', '2222', '--public-host', 'relay.example.invalid', '--public-port', '443',
    ]
  });

  await terminal.wait(/имя.*(?:доступ|подключ)|(?:доступ|подключ).*имя/iu);
  terminal.write('Доступ стенда\r');
  await terminal.wait(/SSH.*(?:адрес|сервер)|(?:адрес|сервер).*SSH/iu);
  terminal.write('127.0.0.1\r');
  await terminal.wait(/пользователь|логин/iu);
  terminal.write('root\r');
  await terminal.wait(/SHA256:fixture-server/u);

  assert.equal(h.calls.some((call) => call.url.endsWith('/credentials')), false);
  terminal.write('да\r');
  await terminal.wait(/пароль/iu);
  terminal.write('RD_CLI_PASSWORD_SENTINEL\r');
  await terminal.wait(/служб|изменени|подтвер/iu);
  assert.equal(h.calls.some((call) => call.url.endsWith('/start')), false);
  terminal.write('да\r');
  await terminal.wait(/GRIGDESK:PHONE:2:/u);
  assert.doesNotMatch(terminal.output(), /RD_CLI_PASSWORD_SENTINEL/u);
  assert.match(terminal.output(), /ожида|подключите|телефон.*не подключ/iu);
  assert.doesNotMatch(terminal.output(), /телефон подключён/iu);
  terminal.write('\x1b');

  const result = await terminal.done;

  assert.equal(result.code, 0, terminal.output());
  assertRestored(result, terminal.output());
  assert.ok(h.calls.some((call) => call.url === '/api/auth/window-session'));

  const created = h.calls.find((call) => call.method === 'POST' && call.url === '/api/mobile/deployments');

  assert.ok(created);
  assert.equal(JSON.parse(created.body).ssh.port, 2222);
  assert.deepEqual(JSON.parse(created.body).public, { host: 'relay.example.invalid', port: 443 });
  assert.equal(h.box.calls().some((call) => call.startsWith('docker ')), false);
});

for (const signal of ['\x03', '\x04']) {
  test(`RD-CTL-02: скрытый пароль, выход ${JSON.stringify(signal)}, восстановление TTY`, async (t) => {
    const h = await relayCliFixture(t);
    const terminal = h.launch('setup');

    await terminal.wait(/имя.*(?:доступ|подключ)|(?:доступ|подключ).*имя/iu);
    terminal.write('Стенд\r');
    await terminal.wait(/SSH.*(?:адрес|сервер)|(?:адрес|сервер).*SSH/iu);
    terminal.write('127.0.0.1\r');
    await terminal.wait(/пользователь|логин/iu);
    terminal.write('root\r');
    await terminal.wait(/SHA256:fixture-server/u);
    terminal.write('да\r');
    await terminal.wait(/пароль/iu);
    terminal.write('RD_HIDDEN_SENTINEL');
    terminal.write(signal);

    const result = await terminal.done;

    assert.equal(result.code, signal === '\x03' ? 130 : 2, terminal.output());
    assertRestored(result, terminal.output());
    assert.doesNotMatch(terminal.output(), /RD_HIDDEN_SENTINEL/u);
    assert.equal(h.calls.some((call) => call.url.endsWith('/start')), false);
  });
}

test('RD-CTL-02: без TTY код 2, секретные flags отказаны без эха значений', async (t) => {
  const h = await relayCliFixture(t);
  const terminal = h.launch('setup', { inputTTY: false, outputTTY: false });
  const result = await terminal.done;

  assert.equal(result.code, 2, terminal.output());
  assert.equal(h.calls.some((call) => call.url.endsWith('/credentials')), false);

  for (const flag of ['--password', '--private-key', '--passphrase']) {
    const failure = await h.box.run(['relay', 'setup', flag, 'RD_SECRET_FLAG_SENTINEL']);

    assert.equal(failure.code, 2);
    assert.doesNotMatch(failure.stdout + failure.stderr, /RD_SECRET_FLAG_SENTINEL/u);
  }
});

test('RD-CTL-01: restore выбирает offline relay и посылает его id общему owner', async (t) => {
  const h = await relayCliFixture(t);
  const terminal = h.launch('restore');

  await terminal.wait(/Прежний доступ/u);
  terminal.write('\r');
  await terminal.wait(/SSH.*(?:адрес|сервер)|(?:адрес|сервер).*SSH/iu);
  terminal.write('127.0.0.1\r');
  await terminal.wait(/пользователь|логин/iu);
  terminal.write('root\r');
  await terminal.wait(/SHA256:fixture-server/u);

  const created = h.calls.find((call) => call.method === 'POST' && call.url === '/api/mobile/deployments');

  assert.ok(created);
  assert.equal(JSON.parse(created.body).mode, 'restore');
  assert.equal(JSON.parse(created.body).relayId, 'r12345678');
  terminal.write('\x03');

  const result = await terminal.done;

  assert.equal(result.code, 130, terminal.output());
  assertRestored(result, terminal.output());
});

test('RD-CTL-02: выбор собственного ключа и скрытый passphrase идут binary body', async (t) => {
  const h = await relayCliFixture(t);
  const passphrase = 'RD_KEY_PASSPHRASE_SENTINEL';
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = pair.privateKey.export({
    type: 'pkcs1',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase
  }).toString();
  const file = path.join(h.box.home, 'synthetic-key.pem');

  await writeFile(file, key, { mode: 0o600 });

  const terminal = h.launch('setup');

  await terminal.wait(/имя.*(?:доступ|подключ)|(?:доступ|подключ).*имя/iu);
  terminal.write('Доступ с ключом\r');
  await terminal.wait(/SSH.*(?:адрес|сервер)|(?:адрес|сервер).*SSH/iu);
  terminal.write('127.0.0.1\r');
  await terminal.wait(/пользователь|логин/iu);
  terminal.write('root\r');
  await terminal.wait(/SHA256:fixture-server/u);
  terminal.write('да\r');
  await terminal.wait(/ключ/iu);
  terminal.write('\x1b[B\r');
  await terminal.wait(/файл|путь/iu);
  terminal.write(file + '\r');
  await terminal.wait(/фраз|passphrase|пароль.*ключ/iu);
  terminal.write(passphrase + '\r');
  await terminal.wait(/служб|изменени|подтвер/iu);

  const credentials = h.calls.find((call) => call.url.endsWith('/credentials'));

  assert.ok(credentials);
  assert.equal(JSON.parse(credentials.body).privateKey, key);
  assert.equal(JSON.parse(credentials.body).passphrase, passphrase);
  assert.doesNotMatch(terminal.output(), /RD_KEY_PASSPHRASE_SENTINEL|BEGIN RSA PRIVATE KEY/u);
  assert.equal(JSON.stringify(h.box.environment).includes(passphrase), false);
  terminal.write('\x03');

  const result = await terminal.done;

  assert.equal(result.code, 130, terminal.output());
  assertRestored(result, terminal.output());
});

test('RD-CTL-02: закрытый после 202 ctl и повтор читают прежнее задание без новых мутаций', async (t) => {
  const h = await relayCliFixture(t, false, { holdInstall: true });
  const first = h.launch('setup');

  await first.wait(/имя.*(?:доступ|подключ)|(?:доступ|подключ).*имя/iu);
  first.write('Продолжение\r');
  await first.wait(/SSH.*(?:адрес|сервер)|(?:адрес|сервер).*SSH/iu);
  first.write('127.0.0.1\r');
  await first.wait(/пользователь|логин/iu);
  first.write('root\r');
  await first.wait(/SHA256:fixture-server/u);
  first.write('да\r');
  await first.wait(/пароль/iu);
  first.write('RD_DETACHED_PASSWORD_SENTINEL\r');
  await first.wait(/служб|изменени|подтвер/iu);
  first.write('да\r');
  await h.box.waitFor(() => h.calls.some((call) => call.url.endsWith('/start')));
  first.signal('SIGTERM');
  await first.done;
  assert.equal(h.job.state, 'installing');

  const before = h.calls.filter((call) => call.url === '/api/mobile/deployments'
    && call.method === 'GET').length;
  const second = h.launch('setup');

  await h.box.waitFor(() => h.calls.filter((call) => call.url === '/api/mobile/deployments'
    && call.method === 'GET').length > before);
  await second.wait(/Выберите задание/iu);
  second.write('\r');
  assert.equal(h.calls.filter((call) => call.url === '/api/mobile/deployments'
    && call.method === 'POST').length, 1);
  assert.equal(h.calls.filter((call) => call.url.endsWith('/credentials')).length, 1);
  assert.equal(h.calls.some((call) => /cancel|delete/iu.test(call.url)), false);
  second.write('\x03');
  await second.done;
  assert.doesNotMatch(second.output(), /RD_DETACHED_PASSWORD_SENTINEL/u);
});

test('RD-CTL-04: чужой setup не мешает restore выбрать подключение и новый SSH', async (t) => {
  const h = await relayCliFixture(t, false, { jobs: [{
    id: 'old-setup-job',
    revision: 5,
    mode: 'setup',
    state: 'interrupted',
    steps: [],
    ssh: {
      host: 'old-vps.example.invalid',
      port: 22,
      user: 'root',
    },
  }] });
  const terminal = h.launch('restore');

  await terminal.wait(/Выберите подключение/iu);
  terminal.write('\r');
  await terminal.wait(/SSH.*адрес/iu);
  terminal.write('new-vps.example.invalid\r');
  await terminal.wait(/Пользователь SSH/iu);
  terminal.write('root\r');
  await terminal.wait(/SHA256:fixture-server/u);
  terminal.write('\x03');
  await terminal.done;

  const created = h.calls.find((call) => call.method === 'POST'
    && call.url === '/api/mobile/deployments');

  assert.ok(created);

  const input = JSON.parse(created.body);

  assert.equal(input.mode, 'restore');
  assert.equal(input.relayId, 'r12345678');
  assert.equal(input.ssh.host, 'new-vps.example.invalid');
  assert.equal(h.calls.some((call) => call.url.includes('old-setup-job/')), false);
});

test('RD-CTL-04: прерванный restore позволяет выбрать новый VPS вместо прежнего SSH', async (t) => {
  const h = await relayCliFixture(t, false, { jobs: [{
    id: 'old-restore-job',
    revision: 5,
    mode: 'restore',
    relayId: 'r12345678',
    state: 'interrupted',
    steps: [],
    public: { host: 'relay.example.invalid', port: 443 },
    ssh: {
      host: 'old-vps.example.invalid',
      port: 22,
      user: 'root',
    },
  }] });
  const terminal = h.launch('restore');

  await terminal.wait(/Выберите задание/iu);
  terminal.write('0\r');
  await terminal.wait(/Выберите подключение/iu);
  terminal.write('\r');
  await terminal.wait(/SSH.*адрес/iu);
  terminal.write('new-vps.example.invalid\r');
  await terminal.wait(/Пользователь SSH/iu);
  terminal.write('root\r');
  await terminal.wait(/SHA256:fixture-server/u);
  terminal.write('\x03');
  await terminal.done;

  assert.equal(h.calls.some((call) => call.url.includes('old-restore-job/')), false);
  assert.equal(h.calls.filter((call) => call.method === 'POST'
    && call.url === '/api/mobile/deployments').length, 1);
});

for (const accepted of [true, false]) {
  test(`RD-CTL-05: новый VPS завершает старое ожидание только с подтверждением=${accepted}`, async (t) => {
    const h = await relayCliFixture(t, false, { jobs: [{
      id: 'waiting-restore-job',
      revision: 3,
      mode: 'restore',
      relayId: 'r12345678',
      state: 'awaiting_credentials',
      steps: [],
      public: { host: 'relay.example.invalid', port: 443 },
      ssh: {
        host: 'old-vps.example.invalid',
        port: 22,
        user: 'root',
      },
    }] });
    const terminal = h.launch('restore');

    await terminal.wait(/Выберите задание/iu);
    terminal.write('0\r');
    await terminal.wait(/Выберите подключение/iu);
    terminal.write('\r');
    await terminal.wait(/SSH.*адрес/iu);
    terminal.write('new-vps.example.invalid\r');
    await terminal.wait(/Пользователь SSH/iu);
    terminal.write('root\r');
    await terminal.wait(/Завершить ожидание/iu);
    assert.equal(h.calls.some((call) => call.url.endsWith('/cancel')), false);
    terminal.write(accepted ? 'да\r' : 'нет\r');

    if (accepted) {
      await terminal.wait(/SHA256:fixture-server/u);
      terminal.write('\x03');
    }

    const result = await terminal.done;
    const cancelled = h.calls.filter((call) => call.url.endsWith('/cancel'));

    assert.equal(cancelled.length, accepted ? 1 : 0);
    assert.equal(result.code, accepted ? 130 : 2);
    assert.equal(h.calls.some((call) => call.url.endsWith('/start')), false);

    if (accepted) {
      assert.ok(cancelled[0]);
      assert.equal(cancelled[0].url, '/api/mobile/deployments/waiting-restore-job/cancel');
      assert.equal(JSON.parse(cancelled[0].body).revision, 3);
    }
  });
}

for (const accepted of [true, false]) {
  test(`RD-CTL-06: setup на новом VPS освобождает прежний DNS только с согласием=${accepted}`, async (t) => {
    const h = await relayCliFixture(t, false, { jobs: [{
      id: 'waiting-setup-job',
      revision: 3,
      mode: 'setup',
      state: 'awaiting_credentials',
      steps: [],
      public: { host: 'relay.example.invalid', port: 443 },
      ssh: {
        host: 'old-vps.example.invalid',
        port: 22,
        user: 'root',
      },
    }] });
    const terminal = h.launch('setup', { args: ['--public-host', 'relay.example.invalid'] });

    await terminal.wait(/Выберите задание/iu);
    terminal.write('0\r');
    await terminal.wait(/Имя подключения/iu);
    terminal.write('Новая попытка\r');
    await terminal.wait(/SSH.*адрес/iu);
    terminal.write('new-vps.example.invalid\r');
    await terminal.wait(/Пользователь SSH/iu);
    terminal.write('root\r');
    await terminal.wait(/Завершить ожидание/iu);
    assert.equal(h.calls.some((call) => call.url.endsWith('/cancel')), false);
    terminal.write(accepted ? 'да\r' : 'нет\r');

    if (accepted) {
      await terminal.wait(/SHA256:fixture-server/u);
      terminal.write('\x03');
    }

    const result = await terminal.done;
    const cancelled = h.calls.filter((call) => call.url.endsWith('/cancel'));
    const created = h.calls.filter((call) => call.method === 'POST'
      && call.url === '/api/mobile/deployments');

    assert.equal(cancelled.length, accepted ? 1 : 0);
    assert.equal(created.length, accepted ? 1 : 0);
    assert.equal(result.code, accepted ? 130 : 2);

    if (accepted) {
      assert.ok(cancelled[0]);
      assert.ok(created[0]);
      assert.equal(cancelled[0].url, '/api/mobile/deployments/waiting-setup-job/cancel');
      assert.equal(JSON.parse(cancelled[0].body).revision, 3);
      assert.equal(JSON.parse(created[0].body).public.host, 'relay.example.invalid');
      assert.equal(JSON.parse(created[0].body).ssh.host, 'new-vps.example.invalid');
      assert.ok(h.calls.indexOf(cancelled[0]) < h.calls.indexOf(created[0]));
    }
  });
}
