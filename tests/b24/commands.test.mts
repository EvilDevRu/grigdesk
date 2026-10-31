import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApiCommand } from '../../b24/src/args.ts';
import { runCommand } from '../../b24/src/commands.ts';
import type { CommandIO } from '../../b24/src/commands.ts';
import { B24Error } from '../../b24/src/errors.ts';
import type { RequestSpec } from '../../b24/src/http.ts';

const CONNECTION = {
  baseUrl: 'http://127.0.0.1:9',
  token: 'tok',
};

interface Recorder extends CommandIO {
  specs: RequestSpec[];
  stdinReads: number;
}

/**
 * Подменяет request и stdin: запросы записываются, ответ — эхо пути.
 * Настоящий транспорт здесь не участвует.
 */
function recorder(stdin: Uint8Array = new Uint8Array()): Recorder {
  const io: Recorder = {
    specs: [],
    stdinReads: 0,
    async request(connection, spec) {
      assert.deepEqual(connection, CONNECTION);
      io.specs.push(spec);

      return new Uint8Array(Buffer.from(spec.path));
    },
    async readStdin() {
      io.stdinReads += 1;

      return stdin;
    },
  };

  return io;
}

test('BM-01: каждая команда строит точный метод, путь и тело', async () => {
  const cases: Array<[ApiCommand, RequestSpec]> = [
    [{ kind: 'dashboard' }, {
      method: 'GET',
      path: '/api/tracker/dashboard',
    }],
    [{ kind: 'task', id: '0042' }, {
      method: 'GET',
      path: '/api/tracker/task/0042',
    }],
    [{ kind: 'task', id: 'a/b?c' }, {
      method: 'GET',
      path: '/api/tracker/task/a%2Fb%3Fc',
    }],
    [{
      kind: 'comment',
      id: '42',
      text: 'текст "с" \\ кавычками\n',
    }, {
      method: 'POST',
      path: '/api/tracker/task/42/comment',
      body: JSON.stringify({ text: 'текст "с" \\ кавычками\n' }),
      json: true,
    }],
    [{ kind: 'complete', id: '42' }, {
      method: 'POST',
      path: '/api/tracker/task/42/complete',
    }],
    [{ kind: 'renew', id: '42' }, {
      method: 'POST',
      path: '/api/tracker/task/42/renew',
    }],
    [{ kind: 'users', query: '' }, {
      method: 'GET',
      path: '/api/tracker/users?q=',
    }],
    [{ kind: 'users', query: 'Иван П&+?' }, {
      method: 'GET',
      path: `/api/tracker/users?${new URLSearchParams({ q: 'Иван П&+?' })}`,
    }],
  ];

  for (const action of ['start', 'pause', 'stop'] as const) {
    cases.push([{
      kind: 'timer',
      id: '42',
      action,
    }, {
      method: 'POST',
      path: `/api/tracker/task/42/timer/${action}`,
    }]);
  }

  for (const [command, spec] of cases) {
    const io = recorder();
    const result = await runCommand(command, CONNECTION, io);

    assert.deepEqual(io.specs, [spec], command.kind);
    assert.equal(Buffer.from(result).toString(), spec.path);
    assert.equal(io.stdinReads, 0, command.kind);
  }

  assert.equal(new URLSearchParams({ q: 'Иван П&+?' }).toString(),
    'q=%D0%98%D0%B2%D0%B0%D0%BD+%D0%9F%26%2B%3F');
});

test('BM-02: create читает stdin ровно один раз и сохраняет байты', async () => {
  for (const text of ['{"title":"т"}\n', '{"title":"т"}\r\n', '', '{not json']) {
    const bytes = new Uint8Array(Buffer.from(text));
    const io = recorder(bytes);

    await runCommand({ kind: 'create' }, CONNECTION, io);
    assert.equal(io.stdinReads, 1);
    assert.equal(io.specs.length, 1);
    assert.equal(io.specs[0]?.method, 'POST');
    assert.equal(io.specs[0]?.path, '/api/tracker/tasks');
    assert.equal(io.specs[0]?.json, true);
    assert.ok(Buffer.from(io.specs[0]?.body as Uint8Array).equals(Buffer.from(text)));
  }

  const failing: CommandIO = {
    async request() {
      throw new Error('request не должен вызываться');
    },
    async readStdin() {
      throw new Error('EIO');
    },
  };

  await assert.rejects(runCommand({ kind: 'create' }, CONNECTION, failing), (error: unknown) => {
    assert.ok(error instanceof B24Error);
    assert.equal(error.code, 1);
    assert.equal(error.message, 'Не удалось прочитать JSON из stdin.');

    return true;
  });
});

test('BM-03: start ждёт renew, подавляет его отказ и возвращает только timer', async () => {
  const outcomes = ['ok', 'http', 'network'] as const;

  for (const renewOutcome of outcomes) {
    for (const timerFails of [false, true]) {
      const order: string[] = [];
      let finishRenew: (() => void) | undefined;
      const renewGate = new Promise<void>((resolve) => {
        finishRenew = resolve;
      });
      const io: CommandIO = {
        /**
         * Renew ждёт ручного завершения: до него timer не должен вызываться.
         * Отказы renew и timer моделируют HTTP 22 и сетевой 22.
         */
        async request(connection, spec) {
          assert.equal(connection.token, 'tok');
          order.push(spec.path);

          if (spec.path.endsWith('/renew')) {
            await renewGate;

            if (renewOutcome === 'http') {
              throw new B24Error(22, 'Запрос к GrigDesk завершился ошибкой HTTP 400.');
            }

            if (renewOutcome === 'network') {
              throw new B24Error(22, 'Не удалось связаться с GrigDesk.');
            }

            return new Uint8Array(Buffer.from('renew-body'));
          }

          if (timerFails) {
            throw new B24Error(22, 'Запрос к GrigDesk завершился ошибкой HTTP 502.');
          }

          return new Uint8Array(Buffer.from('timer-body'));
        },
        async readStdin() {
          throw new Error('stdin не нужен');
        },
      };
      const running = runCommand({ kind: 'start', id: '42' }, CONNECTION, io);

      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order, ['/api/tracker/task/42/renew']);
      finishRenew?.();

      if (timerFails) {
        await assert.rejects(running, (error: unknown) => error instanceof B24Error && error.code === 22);
      } else {
        assert.equal(Buffer.from(await running).toString(), 'timer-body');
      }

      assert.deepEqual(order, ['/api/tracker/task/42/renew', '/api/tracker/task/42/timer/start']);
    }
  }
});
