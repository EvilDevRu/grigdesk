import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecEcho } from '../../server/src/lib/ssh/echo.js';

const ESC = String.fromCharCode(27);

test('рамка запуска показывает команду одной строкой и без управляющих последовательностей', () => {
  const echo = createExecEcho({});
  const head = echo.start(`ls${ESC}[2J /srv\ngrep -n x`);

  assert.deepEqual({
    single: head.trim().split('\n').length,
    hasCommand: head.includes('ls /srv ⏎ grep -n x'),
    hasClearScreen: head.includes(`${ESC}[2J`),
  }, {
    single: 1,
    hasCommand: true,
    hasClearScreen: false,
  });
});

test('вывод чистится от управляющих последовательностей и получает возврат каретки', () => {
  const echo = createExecEcho({});
  echo.start('cat app.log');
  const text = echo.data(Buffer.from(`${ESC}[31mалый\nвторая\n`, 'utf8'));

  assert.deepEqual({
    text,
    tail: echo.finish({ ok: true, exitCode: 0 }).includes('код 0'),
  }, {
    text: 'алый\r\nвторая\r\n',
    tail: true,
  });
});

test('многобайтовый символ не рвётся на границе чанка', () => {
  const echo = createExecEcho({});
  echo.start('printf ы');
  const source = Buffer.from('ы', 'utf8');

  assert.deepEqual({
    first: echo.data(source.subarray(0, 1)),
    second: echo.data(source.subarray(1)),
  }, {
    first: '',
    second: 'ы',
  });
});

test('бюджет эха обрезает поток и сообщает об этом в итоге', () => {
  const echo = createExecEcho({ limitBytes: 8 });
  echo.start('yes');

  assert.deepEqual({
    shown: echo.data(Buffer.from('12345678901234567890', 'utf8')),
    dropped: echo.data(Buffer.from('ещё', 'utf8')),
    tail: echo.finish({ ok: true, exitCode: 0 }).includes('эхо обрезано, показано 8 из 26 байт'),
  }, {
    shown: '12345678',
    dropped: '',
    tail: true,
  });
});

test('итог различает код возврата и обрыв сессии', () => {
  const failed = createExecEcho({});
  failed.start('false');
  const lost = createExecEcho({});
  lost.start('sleep 30');

  assert.deepEqual({
    failed: failed.finish({ ok: false, error: 'command_failed', exitCode: 1 }).includes('код 1'),
    signal: failed.finish({ ok: false, exitCode: 137, signal: 'KILL' }).includes('код 137 (KILL)'),
    lost: lost.finish({ ok: false, error: 'session_lost' }).includes('прервано: session_lost'),
  }, {
    failed: true,
    signal: true,
    lost: true,
  });
});

test('итог начинается с новой строки, если вывод оборвался посреди строки', () => {
  const echo = createExecEcho({});
  echo.start('printf hi');
  echo.data(Buffer.from('hi', 'utf8'));

  assert.equal(echo.finish({ ok: true, exitCode: 0 }).startsWith('\r\n'), true);
});
