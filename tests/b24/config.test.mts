import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConnection } from '../../b24/src/config.ts';
import type { ConfigIO } from '../../b24/src/config.ts';
import { B24Error } from '../../b24/src/errors.ts';

type Files = Record<string, string | null | NodeJS.ErrnoException>;

interface FakeIO extends ConfigIO {
  reads: string[];
  homes: number;
}

/**
 * Подменяет чтение файлов словарём путей без обращения к диску.
 * Каждый запрошенный путь записывается: так тест видит лишние чтения.
 */
function fakeIO(files: Files = {}, home = '/home/user'): FakeIO {
  const io: FakeIO = {
    reads: [],
    homes: 0,
    getHome() {
      io.homes += 1;

      return home;
    },
    /**
     * Возвращает подставленный текст или бросает подставленную ошибку errno.
     * Отсутствующий в словаре путь означает ENOENT, то есть null.
     */
    async readText(file: string) {
      io.reads.push(file);

      const value = files[file];

      if (value instanceof Error) {
        throw value;
      }

      return value ?? null;
    },
  };

  return io;
}

/**
 * Ошибка файловой системы с кодом errno, как её бросает fs/promises.
 * Сообщение намеренно английское: config не должен его показывать.
 */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: system failure`), { code });
}

/**
 * Ожидает отказ B24Error с кодом и точным сообщением.
 * Сообщение не должно содержать значения токена.
 */
async function rejectsWith(promise: Promise<unknown>, code: number, message: string | RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof B24Error, String(error));
    assert.equal(error.code, code);

    if (typeof message === 'string') {
      assert.equal(error.message, message);
    } else {
      assert.match(error.message, message);
    }

    return true;
  });
}

const throwingIO: ConfigIO = {
  getHome() {
    throw new Error('getHome не должен вызываться');
  },
  async readText() {
    throw new Error('readText не должен вызываться');
  },
};

test('BC-01: явные URL и токен не обращаются к папке и файлам', async () => {
  for (const env of [
    {
      COCKPIT_URL: 'http://127.0.0.1:9/',
      COCKPIT_TOKEN: 'secret',
      COCKPIT_HOME: 'relative bad',
      HOME: 'bad',
    },
    {
      COCKPIT_URL: 'https://example.test/base/',
      COCKPIT_TOKEN: 'secret',
      COCKPIT_ENV_FILE: '/missing/.env',
    },
  ]) {
    const connection = await resolveConnection(env, throwingIO);

    assert.equal(connection.token, 'secret');
    assert.ok(!connection.baseUrl.endsWith('/'), connection.baseUrl);
  }
});

test('BC-02: URL по порту и токен по общей раскладке', async () => {
  const io = fakeIO({ '/home/user/.cockpit/state/cli-token': 'tok-home\n' });

  assert.deepEqual(await resolveConnection({ HOME: '/home/user' }, io), {
    baseUrl: 'http://localhost:8140',
    token: 'tok-home',
  });
  assert.deepEqual(io.reads, ['/home/user/.cockpit/.env', '/home/user/.cockpit/state/cli-token']);

  const custom = fakeIO({ '/data/c/state/cli-token': 'tok-data' });

  assert.deepEqual(await resolveConnection({ COCKPIT_HOME: '/data/c//' }, custom), {
    baseUrl: 'http://localhost:8140',
    token: 'tok-data',
  });
  assert.deepEqual(custom.reads, ['/data/c/.env', '/data/c/state/cli-token']);
  assert.equal(custom.homes, 1);
});

test('BC-03: явный env-файл и exported overrides', async () => {
  const io = fakeIO({
    '/etc/cockpit.env': [
      'COCKPIT_PORT=18140',
      'COCKPIT_CLI_TOKEN_PATH="/run/с пробелом/token"',
      'COCKPIT_URL=http://evil.test',
      'COCKPIT_TOKEN=from-file',
    ].join('\n'),
    '/run/с пробелом/token': '  tok-file  \n',
  });

  assert.deepEqual(await resolveConnection({
    HOME: '/home/user',
    COCKPIT_ENV_FILE: '/etc/cockpit.env',
  }, io), {
    baseUrl: 'http://localhost:18140',
    token: 'tok-file',
  });
  assert.deepEqual(io.reads, ['/etc/cockpit.env', '/run/с пробелом/token']);

  const overrides = fakeIO({
    '/etc/cockpit.env': 'COCKPIT_PORT=18140\nCOCKPIT_CLI_TOKEN_PATH=/file-token\n',
    '/env-token': 'tok-env-path',
    '/home/user/.cockpit/state/cli-token': 'tok-default',
  });

  assert.deepEqual(await resolveConnection({
    HOME: '/home/user',
    COCKPIT_ENV_FILE: '/etc/cockpit.env',
    COCKPIT_PORT: '28140',
    COCKPIT_CLI_TOKEN_PATH: '/env-token',
  }, overrides), {
    baseUrl: 'http://localhost:28140',
    token: 'tok-env-path',
  });
  assert.deepEqual(await resolveConnection({
    HOME: '/home/user',
    COCKPIT_ENV_FILE: '/etc/cockpit.env',
    COCKPIT_PORT: '',
    COCKPIT_CLI_TOKEN_PATH: '',
  }, overrides), {
    baseUrl: 'http://localhost:8140',
    token: 'tok-default',
  });

  const tokenOnly = fakeIO({ '/etc/cockpit.env': 'COCKPIT_PORT=18140\n' });

  assert.deepEqual(await resolveConnection({
    HOME: '/home/user',
    COCKPIT_ENV_FILE: '/etc/cockpit.env',
    COCKPIT_TOKEN: 'explicit',
  }, tokenOnly), {
    baseUrl: 'http://localhost:18140',
    token: 'explicit',
  });
  assert.deepEqual(tokenOnly.reads, ['/etc/cockpit.env']);
});

test('BC-04: отсутствующий env-файл допустим, отказ чтения нет', async () => {
  const missing = fakeIO({
    '/home/user/.cockpit/.env': null,
    '/home/user/.cockpit/state/cli-token': 'tok',
  });

  assert.equal((await resolveConnection({ HOME: '/home/user' }, missing)).token, 'tok');

  for (const code of ['EACCES', 'EISDIR']) {
    const io = fakeIO({ '/home/user/.cockpit/.env': errno(code) });

    await rejectsWith(resolveConnection({ HOME: '/home/user' }, io), 1,
      'Не удалось прочитать настройки: /home/user/.cockpit/.env.');
    assert.deepEqual(io.reads, ['/home/user/.cockpit/.env']);
  }
});

test('BC-05: отсутствие токена называет ожидаемый путь', async () => {
  const standard = '/home/user/.cockpit/state/cli-token';

  for (const value of [null, '', ' \n\t ', errno('EACCES'), errno('EISDIR')]) {
    await rejectsWith(resolveConnection({ HOME: '/home/user' }, fakeIO({ [standard]: value })), 1,
      `Нет токена: ${standard}.`);
  }

  await rejectsWith(resolveConnection({
    HOME: '/home/user',
    COCKPIT_CLI_TOKEN_PATH: '/custom/token',
  }, fakeIO()), 1, 'Нет токена: /custom/token.');
  await rejectsWith(resolveConnection({
    HOME: '/home/user',
    COCKPIT_CLI_TOKEN_PATH: 'relative/token',
  }, fakeIO()), 1, 'Нет токена: relative/token.');
});

test('BC-06: файл — данные, окружение не меняется', async () => {
  const env = {
    HOME: '/home/user',
    COCKPIT_ENV_FILE: '/etc/cockpit.env',
  };
  const snapshot = { ...env };
  const io = fakeIO({
    '/etc/cockpit.env': 'COCKPIT_CLI_TOKEN_PATH=/tok/$(touch /tmp/b24-pwned)\nUNRELATED=`id`\n',
    '/tok/$(touch /tmp/b24-pwned)': 'tok',
  });

  assert.equal((await resolveConnection(env, io)).token, 'tok');
  assert.deepEqual(env, snapshot);
  assert.equal(process.env.UNRELATED, undefined);
  assert.deepEqual(io.reads, ['/etc/cockpit.env', '/tok/$(touch /tmp/b24-pwned)']);
});

test('BC-07: старая раскладка не запрашивается', async () => {
  const io = fakeIO({
    '/code/server/.state/cli-token': 'old',
    '/code/.env': 'COCKPIT_PORT=1',
  });

  await rejectsWith(resolveConnection({ HOME: '/home/user' }, io), 1,
    'Нет токена: /home/user/.cockpit/state/cli-token.');
  assert.deepEqual(io.reads, ['/home/user/.cockpit/.env', '/home/user/.cockpit/state/cli-token']);
});

test('BC-08: адрес и порт проверяются до HTTP', async () => {
  const valid: Array<[string, string]> = [
    ['http://127.0.0.1:8140', 'http://127.0.0.1:8140'],
    ['https://cockpit.test/', 'https://cockpit.test'],
    ['http://127.0.0.1:8140/base//', 'http://127.0.0.1:8140/base'],
  ];

  for (const [url, baseUrl] of valid) {
    assert.equal((await resolveConnection({
      COCKPIT_URL: url,
      COCKPIT_TOKEN: 't',
    }, throwingIO)).baseUrl, baseUrl);
  }

  const address = 'Некорректный адрес Cockpit: нужен HTTP(S) URL без учётных данных и query.';

  for (const url of ['not a url', 'ftp://host/', 'http://user:pass@host/', 'http://user@host/',
    'http://host/?q=1', 'http://host/#frag', 'file:///etc/passwd']) {
    await rejectsWith(resolveConnection({
      COCKPIT_URL: url,
      COCKPIT_TOKEN: 't',
    }, throwingIO), 1, address);
  }

  const port = 'Некорректный порт Cockpit: нужно целое число от 1 до 65535.';

  for (const value of ['-1', '1.5', '65536']) {
    await rejectsWith(resolveConnection({
      HOME: '/home/user',
      COCKPIT_PORT: value,
      COCKPIT_TOKEN: 't',
    }, fakeIO()), 1, port);
  }

  for (const value of ['abc', '', '0']) {
    assert.equal((await resolveConnection({
      HOME: '/home/user',
      COCKPIT_PORT: value,
      COCKPIT_TOKEN: 't',
    }, fakeIO())).baseUrl, 'http://localhost:8140', value);
  }
});

test('BC-09: токен обрезается только при чтении файла', async () => {
  const standard = '/home/user/.cockpit/state/cli-token';

  for (const text of ['tok\n', 'tok\r\n', '\r\n tok \r\n']) {
    const connection = await resolveConnection({ HOME: '/home/user' }, fakeIO({ [standard]: text }));

    assert.equal(connection.token, 'tok');
  }

  for (const token of ['   ', 'a\nb', 'a\rb', 'a\0b']) {
    await assert.rejects(resolveConnection({
      COCKPIT_URL: 'http://127.0.0.1:1',
      COCKPIT_TOKEN: token,
    }, throwingIO), (error: unknown) => {
      assert.ok(error instanceof B24Error);
      assert.equal(error.code, 1);
      assert.equal(error.message, 'Некорректный токен Cockpit.');
      assert.ok(!error.message.includes(token));

      return true;
    });
  }
});

test('BC-10: запрещённые ключи настроек дают общий отказ', async () => {
  for (const key of ['COCKPIT_HOME', 'COCKPIT_ENV_FILE']) {
    await rejectsWith(resolveConnection({ HOME: '/home/user' }, fakeIO({
      '/home/user/.cockpit/.env': `${key}=\n`,
    })), 1, `Ключ ${key} запрещён в файле настроек.`);
  }

  await rejectsWith(resolveConnection({ COCKPIT_HOME: 'relative' }, fakeIO()), 1,
    /^COCKPIT_HOME должен быть абсолютным путём/);
});
