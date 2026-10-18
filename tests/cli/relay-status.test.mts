import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { dockerProblem, parseLinks, parseRelayList, pickRelay, relayState } from '../../cli/relay.ts';
import { printable, renderText, toJson } from '../../cli/status.ts';
import type { StatusSnapshot } from '../../cli/status.ts';
import type { RunResult } from '../../cli/system.ts';
import { createSandbox } from './helpers/sandbox.mts';

const ready: StatusSnapshot = {
  server: {
    state: 'ready',
    managed: true,
    url: 'http://127.0.0.1:8140/',
    reason: null,
  },
  window: { state: 'closed' },
  relay: {
    state: 'ready',
    container: 'example-relay-1',
    reason: null,
    links: [{
      name: 'Дом',
      state: 'online',
    }],
  },
};

test('RS-1 точные метки compose и явный project', () => {
  const list = parseRelayList([
    'own\tproject\t/example/relay/compose.yaml',
    'test\ttest-project\t/example/relay/compose.yaml,/tmp/extra.yaml',
    'other\tother-project\t/elsewhere/relay/compose.yaml',
  ].join('\n'));
  const options = {
    composeFile: '/example/relay/compose.yaml',
    project: null,
  };

  assert.equal(list.length, 3);
  assert.deepEqual(pickRelay(list, options), {
    kind: 'one',
    container: list[0],
  });
  assert.deepEqual(pickRelay([...list, {
    ...list[0]!,
    name: 'second',
  }], options), {
    kind: 'many',
    names: ['own', 'second'],
  });
  assert.deepEqual(pickRelay(list, {
    ...options,
    project: 'test-project',
  }), {
    kind: 'one',
    container: list[1],
  });
  assert.deepEqual(pickRelay([], options), { kind: 'none' });
});

test('RS-2 все состояния inspect', () => {
  for (const [inspect, state] of [
    ['running\thealthy', 'ready'],
    ['running\t', 'ready'],
    ['running\tstarting', 'starting'],
    ['restarting\t', 'starting'],
    ['running\tunhealthy', 'unhealthy'],
    ['exited\t', 'stopped'],
    ['created\t', 'stopped'],
  ]) {
    assert.equal(relayState(inspect!), state);
  }
});

test('RS-3 Docker отсутствует либо daemon недоступен', () => {
  const result: RunResult = {
    code: 1,
    stdout: '',
    stderr: 'Первый отказ\nлишняя строка',
    missing: true,
    timedOut: false,
  };

  assert.deepEqual(dockerProblem(result), {
    state: 'not_deployed',
    reason: 'Docker не установлен',
  });
  assert.deepEqual(dockerProblem({
    ...result,
    missing: false,
  }), {
    state: 'docker_unavailable',
    reason: 'Docker недоступен: Первый отказ',
  });
});

test('RS-4 только имена и состояния связей', () => {
  assert.deepEqual(parseLinks({
    relays: [
      {
        name: 'Дом',
        link: { state: 'online' },
        devices: [{ name: 'secret-device' }],
      },
      {
        name: 'VDS',
        link: { state: 'future' },
      },
    ],
  }), [{
    name: 'Дом',
    state: 'online',
  }, {
    name: 'VDS',
    state: 'unknown',
  }]);
  assert.equal(parseLinks({ relays: {} }), null);
  assert.equal(parseLinks(null), null);
});

test('RS-5 управляющие символы очищаются, кириллица сохраняется', () => {
  assert.equal(printable('Дом\x1b\x07\n\x85'), 'Дом????');
});

test('RS-6 текст, цвета и подсказки', () => {
  const plain = renderText(ready, { color: false });

  assert.match(plain, /GrigDesk\n/);
  assert.match(plain, /Сервер.*Работает.*http:\/\/127.0.0.1:8140\//);
  assert.match(plain, /Окно.*Закрыто/);
  assert.match(plain, /Посредник.*Работает.*example-relay-1/);
  assert.match(plain, /связь: Дом — на связи/);
  assert.match(plain, /Открыть окно: grigdesk/);
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(renderText(ready, { color: true }), /\x1b\[32m/);
  assert.match(renderText({ relay: {
    ...ready.relay!,
    state: 'unhealthy',
  } }, { color: false }),
    /Не проходит проверку +example-relay-1/);

  const starting = renderText({
    server: {
      ...ready.server!,
      state: 'starting',
      reason: 'ждёт VPN: маршрут',
    },
  }, { color: false });

  assert.match(starting, /Запускается.*ждёт VPN/);
  assert.match(starting, /Журнал сервера: grigdesk-ctl server logs/);
  assert.doesNotMatch(starting, /GrigDesk\n/);
  assert.match(renderText({ server: {
    ...ready.server!,
    state: 'stopped',
  } }, { color: false }),
    /Запустить сервер: grigdesk-ctl server start/);
  assert.match(renderText({ window: { state: 'not_installed' } }, { color: false }),
    /Установить окно: grigdesk-ctl desktop install/);
});

test('RS-7 JSON содержит только публичные поля и очищает причины', () => {
  const source = {
    ...ready,
    relay: {
      ...ready.relay!,
      container: 'example\x1b',
      reason: 'причина\n',
    },
    token: 'should-not-escape',
  };
  const json = toJson(source);
  const parsed = JSON.parse(json);

  assert.deepEqual(Object.keys(parsed), ['server', 'window', 'relay']);
  assert.deepEqual(Object.keys(parsed.server), ['state', 'managed', 'url', 'reason']);
  assert.deepEqual(Object.keys(parsed.window), ['state']);
  assert.deepEqual(Object.keys(parsed.relay), ['state', 'container', 'reason', 'links']);
  assert.equal(parsed.relay.container, 'example?');
  assert.equal(parsed.relay.reason, 'причина?');
  assert.ok(json.endsWith('\n'));
});

test('RS-8 выбор своего контейнера из Docker', async (t) => {
  const box = await createSandbox(t);

  box.docker([
    `example-relay-1\tproject\t${path.join(box.root, 'relay/compose.yaml')}`,
    `test-relay-1\ttest-project\t${path.join(box.root, 'relay/compose.yaml')},/tmp/test.yaml`,
  ]);

  const result = await box.run(['relay', 'status', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).relay.state, 'ready');
  assert.equal(JSON.parse(result.stdout).relay.container, 'example-relay-1');
});

test('RS-9 start, stop, restart и logs контейнера', async (t) => {
  const box = await createSandbox(t);
  const row = `example-relay-1\tproject\t${path.join(box.root, 'relay/compose.yaml')}`;

  box.docker([row], 'exited\t');

  const start = await box.run(['relay', 'start']);

  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, /Посредник запущен/);
  assert.ok(box.calls().includes('docker start example-relay-1'));
  box.docker([row]);

  for (const action of ['stop', 'restart']) {
    const result = await box.run(['relay', action]);

    assert.equal(result.code, 0, result.stderr);
    assert.ok(box.calls().includes(`docker ${action} example-relay-1`));
  }

  box.fail('docker', 4);

  const logs = await box.run(['relay', 'logs', '-n', '5', '-f']);

  assert.equal(logs.code, 4);
  assert.ok(box.calls().includes('docker logs --tail 5 --follow example-relay-1'));

  const stopped = await createSandbox(t);

  stopped.docker([`example-relay-1\tproject\t${stopped.root}/relay/compose.yaml`], 'exited\t');

  const stop = await stopped.run(['relay', 'stop']);

  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /уже остановлен/);
  assert.ok(!stopped.calls().some((call) => call.startsWith('docker stop ')));
});

test('RS-10 несколько контейнеров требуют явный проект', async (t) => {
  const box = await createSandbox(t);

  box.docker([
    `one\tfirst\t${box.root}/relay/compose.yaml`,
    `two\tsecond\t${box.root}/relay/compose.yaml`,
  ], 'exited\t');

  const ambiguous = await box.run(['relay', 'start']);

  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /несколько посредников/);
  assert.match(ambiguous.stderr, /GRIGDESK_RELAY_PROJECT/);
  assert.ok(!box.calls().some((call) => call.startsWith('docker start ')));

  const selected = await box.run(['relay', 'start'], { GRIGDESK_RELAY_PROJECT: 'second' });

  assert.equal(selected.code, 0, selected.stderr);
  assert.ok(box.calls().includes('docker start two'));
});

test('RS-11 нет контейнера и Docker недоступен', async (t) => {
  const box = await createSandbox(t);
  const missing = await box.run(['relay', 'start']);

  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Локальный посредник не найден/);
  assert.match(missing.stderr, /relay-deploy.md/);
  box.docker('unavailable');

  const action = await box.run(['relay', 'start']);
  const status = await box.run(['relay', 'status', '--json']);

  assert.equal(action.code, 1);
  assert.match(action.stderr, /Docker недоступен/);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).relay.state, 'docker_unavailable');
});

test('RS-12 полный JSON без токена, устройств и управляющих символов', async (t) => {
  const box = await createSandbox(t);

  box.unit({ ActiveState: 'active' });
  await box.serve('grigdesk', {
    relays: [
      {
        name: 'Дом\x1b[31m',
        link: { state: 'online' },
        devices: [{ name: 'secret-device' }],
      },
      {
        name: 'VDS',
        link: { state: 'waiting_vpn' },
      },
    ],
  });

  const result = await box.run(['status', '--json']);
  const output = result.stdout + result.stderr;

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(output, /sandbox-cli-token|secret-device|\x1b/);

  const snapshot = JSON.parse(result.stdout);

  assert.equal(snapshot.window.state, 'not_installed');
  assert.deepEqual(snapshot.relay.links, [
    {
      name: 'Дом?[31m',
      state: 'online',
    },
    {
      name: 'VDS',
      state: 'waiting_vpn',
    },
  ]);
  assert.deepEqual(Object.keys(snapshot), ['server', 'window', 'relay']);
});

test('RS-13 status в pipe без цвета', async (t) => {
  const box = await createSandbox(t);
  const result = await box.run(['status']);

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\x1b/);
  assert.match(result.stdout, /Сервер/);
  assert.match(result.stdout, /Окно/);
  assert.match(result.stdout, /Посредник/);
});

test('RS-14 без готового сервера связи неизвестны', async (t) => {
  const box = await createSandbox(t);
  const result = await box.run(['status', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).relay.links, null);
});

test('RS-15 status вызывает только чтение источников', async (t) => {
  const box = await createSandbox(t);

  box.unit({ ActiveState: 'activating' });
  box.journal('VPN-ворота: маршрут — запуск запрещён');
  box.docker([`example-relay-1\tproject\t${box.root}/relay/compose.yaml`]);

  const result = await box.run(['status', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(box.calls().length, 4);

  for (const call of box.calls()) {
    assert.match(call, /^(systemctl --user show |journalctl .* -n 50 |docker ps |docker inspect )/);
  }
});
