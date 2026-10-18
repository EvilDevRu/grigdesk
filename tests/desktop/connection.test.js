import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ORIGIN,
  localOrigin,
  localPort,
  originFromArgs,
  resolveConnection,
} from '../../desktop/src/connection.ts';

test('DW-01: явный адрес нормализуется', () => {
  for (const port of [1, 80, 8140, 65535]) {
    const origin = port === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${port}`;

    for (const suffix of ['', '/']) {
      assert.equal(localOrigin(`http://127.0.0.1:${port}${suffix}`), origin);
    }

    assert.equal(localPort(origin), port);
  }
});

test('DW-02: нестрогий адрес отвергается', () => {
  for (const value of [
    'https://127.0.0.1:8140',
    'http://localhost:8140',
    'http://127.0.0.2:8140',
    'http://127.1:8140',
    'http://2130706433:8140',
    'http://0177.0.0.1:8140',
    'http://127.0.0.1',
    'http://127.0.0.1/',
    'http://127.0.0.1:0',
    'http://127.0.0.1:080',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:-1',
    'http://127.0.0.1:1.5',
    'http://127.0.0.1:+80',
    'http://user:pass@127.0.0.1:8140',
    'http://127.0.0.1:8140/chats',
    'http://127.0.0.1:8140/../',
    'http://127.0.0.1:8140//',
    'http://127.0.0.1:8140?',
    'http://127.0.0.1:8140#',
    ' http://127.0.0.1:8140',
    'http://127.0.0.1:8140 ',
    'http://127.0.0.1:8140\n',
    'http://127.0.0.1:81\t40',
    'http:\\127.0.0.1:8140',
    'http://127.0.0.1:8140\\',
    'HTTP://127.0.0.1:8140',
    'http://127.0.0.1:' + '1'.repeat(90),
    8140,
    null,
    undefined,
    {},
  ]) {
    assert.equal(localOrigin(value), null, String(value));
  }
});

test('DW-03: аргумент отсутствует, корректен или ошибочен', () => {
  assert.equal(originFromArgs(['electron', '/app', '--disable-gpu']), null);
  assert.deepEqual(originFromArgs([
    'electron',
    '/app',
    '--disable-gpu',
    '--grigdesk-url=http://127.0.0.1:80/',
  ]), { origin: 'http://127.0.0.1' });

  for (const argv of [
    ['--grigdesk-url='],
    ['--grigdesk-url'],
    ['--grigdesk-url', 'http://127.0.0.1:8140'],
    ['--grigdesk-url=http://localhost:8140'],
    ['--grigdesk-url=http://127.0.0.1:1', '--grigdesk-url=http://127.0.0.1:2'],
    ['--grigdesk-url', '--grigdesk-url=http://127.0.0.1:8140'],
  ]) {
    assert.deepEqual(originFromArgs(argv), {
      error: 'Адрес GrigDesk должен быть вида http://127.0.0.1:<порт>/.',
    });
  }
});

test('DW-04: аргумент важнее настройки', () => {
  assert.deepEqual(resolveConnection({
    argv: ['--grigdesk-url=http://127.0.0.1:1/'],
    saved: {
      kind: 'local',
      origin: 'http://127.0.0.1:2',
    },
  }), {
    connection: {
      kind: 'local',
      origin: 'http://127.0.0.1:1',
    },
    fromArgs: true,
  });
});

test('DW-05: настройка или default', () => {
  assert.equal(DEFAULT_ORIGIN, 'http://127.0.0.1:8140');

  for (const origin of ['http://127.0.0.1:2', 'http://127.0.0.1']) {
    assert.deepEqual(resolveConnection({
      argv: [],
      saved: {
        kind: 'local',
        origin,
      },
    }), {
      connection: {
        kind: 'local',
        origin,
      },
      fromArgs: false,
    });
  }

  for (const saved of [
    null,
    'http://127.0.0.1:2',
    [],
    {
      kind: 'remote',
      origin: 'http://127.0.0.1:2',
    },
    {
      kind: 'local',
      origin: 'http://localhost:8140',
    },
    {
      kind: 'local',
      origin: 'http://127.0.0.1:80',
    },
    {
      kind: 'local',
      origin: 'http://127.0.0.1:8140/',
    },
  ]) {
    assert.deepEqual(resolveConnection({
      argv: [],
      saved,
    }), {
      connection: {
        kind: 'local',
        origin: DEFAULT_ORIGIN,
      },
      fromArgs: false,
    });
  }
});

test('DW-06: неверный аргумент не скрывается настройкой', () => {
  for (const argv of [['--grigdesk-url='], ['--grigdesk-url=http://localhost:8140']]) {
    assert.deepEqual(resolveConnection({
      argv,
      saved: {
        kind: 'local',
        origin: DEFAULT_ORIGIN,
      },
    }), {
      error: 'Адрес GrigDesk должен быть вида http://127.0.0.1:<порт>/.',
    });
  }
});

test('CN-01 установленный адрес важнее сохранённого, аргумент важнее установленного', () => {
  for (const installed of ['http://127.0.0.1:9300', 'http://127.0.0.1']) {
    const saved = {
      kind: 'local',
      origin: 'http://127.0.0.1:9200',
    };

    assert.deepEqual(resolveConnection({
      argv: [],
      saved,
      installed,
    }), {
      connection: {
        kind: 'local',
        origin: installed,
      },
      fromArgs: false,
    });
    assert.equal(resolveConnection({
      argv: ['--grigdesk-url=http://127.0.0.1:9400'],
      saved,
      installed,
    }).connection.origin, 'http://127.0.0.1:9400');
  }
});

test('CN-02 отсутствие installed сохраняет прежний порядок', () => {
  assert.equal(resolveConnection({
    argv: [],
    saved: {
      kind: 'local',
      origin: 'http://127.0.0.1:9200',
    },
  }).connection.origin, 'http://127.0.0.1:9200');
  assert.equal(resolveConnection({
    argv: [],
    saved: null,
  }).connection.origin, DEFAULT_ORIGIN);
});

test('CN-03 некорректный или неканонический installed игнорируется', () => {
  for (const installed of [
    'http://example.invalid:80/',
    'http://127.0.0.1:9300/',
    'http://127.0.0.1:80',
    'http://localhost:9300',
    '',
    null,
  ]) {
    assert.equal(resolveConnection({
      argv: [],
      saved: {
        kind: 'local',
        origin: 'http://127.0.0.1:9200',
      },
      installed,
    }).connection.origin, 'http://127.0.0.1:9200');
  }
});
