import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import {
  sourceMenu, launchMenu, down, enterGroup, exitMenus, visibleLines,
} from './helpers/menuFixture.mts';
import { assertRestored, startPty } from './helpers/pty.mts';

/**
 * Проверяет только последний видимый экран после перерисовки, а не историю терминала.
 * Так найденная раньше строка не маскирует потерю данных при прокрутке или resize.
 */
function lastScreen(output: string): string {
  return stripVTControlCharacters(output.slice(output.lastIndexOf('\x1b[H\x1b[J')));
}

/**
 * Сервер устройств принадлежит одной CLI-фикстуре и имитирует обмен ключа на сессию.
 * Строка привязки и QR заведомо вымышленные; живые устройства и секреты не читаются.
 */
async function deviceApi(t: TestContext, box: Awaited<ReturnType<typeof sourceMenu>>) {
  const key = path.join(box.home, 'window-key');

  await writeFile(key, 'fixture-key');
  await writeFile(path.join(box.home, '.grigdesk/.env'),
    `GRIGDESK_PORT=${box.port}\nGRIGDESK_WINDOW_KEY_PATH=${key}\n`);

  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');

    if (request.url?.startsWith('/api/auth/window-session')) {
      response.setHeader('set-cookie', 'fixture-session=ok; HttpOnly');
      response.end('{}');
    } else if (request.url === '/api/devices/pairing') {
      response.end(JSON.stringify({
        text: 'GRIGDESK:PAIR:1:fixture',
        qr: { rows: ['101', '010', '101'] },
      }));
    } else {
      response.end(JSON.stringify({ devices: [] }));
    }
  });

  await new Promise<void>((resolve) => server.listen(box.port, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

test('экраны: журнал просматривается целиком без повторного вызова команды', async (t) => {
  const box = await sourceMenu(t);

  box.journal(Array.from({ length: 70 }, (_, index) => `journal-${String(index + 1).padStart(3, '0')}`)
    .join('\n') + '\n');

  const session = launchMenu(t, box);

  await enterGroup(session, 2, /Запустить/u);
  session.write(down.repeat(3) + '\r');
  await session.wait(/✓ Готово/u);
  assert.match(lastScreen(session.output()), /journal-001/u);
  assert.doesNotMatch(lastScreen(session.output()), /journal-070/u);

  let before = session.output().length;

  session.write('\x1b[F');
  await session.wait(/journal-070/u, 4000, before);
  assert.match(lastScreen(session.output()), /journal-070/u);

  before = session.output().length;
  session.resize(40);
  await session.wait(/journal-070/u, 4000, before);
  assert.ok(visibleLines(session.output().slice(before)).every((line) => [...line].length < 40));

  before = session.output().length;
  session.write('\x1b[H');
  await session.wait(/journal-001/u, 4000, before);
  assert.equal(box.calls().filter((call) => call.includes('journalctl --user')).length, 1);
  assertRestored(await exitMenus(session), session.output());
});

for (const mode of ['color', 'NO_COLOR', 'dumb']) {
  test(`экраны: прямой status завершает работу без клавиши и сохраняет локаль, ${mode}`, async (t) => {
    const box = await sourceMenu(t);
    const session = startPty(t, {
      argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl'), 'status'],
      env: {
        ...box.environment,
        LC_ALL: '',
        LC_MESSAGES: '',
        LANG: 'en_US.UTF-8',
        TERM: mode === 'dumb' ? 'dumb' : 'xterm-256color',
        ...(mode === 'NO_COLOR' ? { NO_COLOR: '1' } : {}),
      },
    });
    const result = await session.done;
    const output = stripVTControlCharacters(session.output());

    assert.equal(result.code, 0);
    assert.match(output, /✓ Done/u);
    assert.match(output, /Server.*stopped/u);
    assert.match(output, /Start server: grigdesk-ctl server start/u);
    assert.ok(!box.calls().some((call) => call.includes('systemctl --user start')));

    if (mode !== 'color') {
      assert.doesNotMatch(session.output(), /\x1b\[[\d;]*m/u);
    }

    if (mode === 'dumb') {
      assert.doesNotMatch(session.output(), /\x1b/u);
    }

    assertRestored(result, session.output());
  });
}

test('экраны: JSON в настоящем TTY остаётся одним документом без оформления', async (t) => {
  const box = await sourceMenu(t);
  const session = startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl'), 'status', '--json'],
    env: box.environment,
  });
  const result = await session.done;
  const document = JSON.parse(session.output());

  assert.equal(result.code, 0);
  assert.equal(document.server.state, 'stopped');
  assert.doesNotMatch(session.output(), /\x1b/u);
  assertRestored(result, session.output());
});

test('экраны: ошибка прямого действия сохраняет код и восстанавливает терминал', async (t) => {
  const box = await sourceMenu(t);

  box.docker('unavailable');

  const session = startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl'), 'relay', 'start'],
    env: box.environment,
  });
  const result = await session.done;
  const output = stripVTControlCharacters(session.output());

  assert.equal(result.code, 1);
  assert.match(output, /✗.*1/u);
  assert.match(output, /Docker/u);
  assert.ok(!box.calls().some((call) => call.startsWith('docker start')));
  assertRestored(result, session.output());
});

test('экраны: длинный ввод показывает конец строки и отменяется без запроса устройства', async (t) => {
  const box = await sourceMenu(t);
  const session = launchMenu(t, box);

  await enterGroup(session, 4, /Привязать/u);
  session.write('\r');
  await session.wait(/имя/iu);

  session.write('Длинное имя '.repeat(8) + 'Конец');
  await session.wait(/Конец▏/u);
  await box.waitFor(() => /Конец▏/u.test(lastScreen(session.output()))
    && /Enter подтвердить/u.test(lastScreen(session.output())));

  const before = session.output().length;

  session.resize(40);
  await session.wait(/Конец▏/u, 4000, before);
  await box.waitFor(() => /Конец▏/u.test(lastScreen(session.output()))
    && /Enter подтвердить/u.test(lastScreen(session.output())));
  assert.match(lastScreen(session.output()), /Конец▏/u);
  session.write('\x1b');
  assert.equal(box.requests().length, 0);
  assertRestored(await exitMenus(session), session.output());
});

test('экраны: QR имеет светлое поле, при сужении остаётся полная строка привязки', async (t) => {
  const box = await sourceMenu(t);

  await deviceApi(t, box);

  const session = startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl'), 'device', 'add', 'Телефон'],
    env: {
      ...box.environment,
      LANG: 'ru_RU.UTF-8',
      LC_ALL: '',
      LC_MESSAGES: '',
      TERM: 'xterm-256color',
    },
    rows: 48,
  });
  const result = await session.done;

  assert.equal(result.code, 0);
  assert.match(session.output(), /\x1b\[47m/u);
  assert.match(stripVTControlCharacters(session.output()), /GRIGDESK:PAIR:1:fixture/u);
  assertRestored(result, session.output());

  const narrow = startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl'), 'device', 'add', 'Телефон'],
    env: {
      ...box.environment,
      LANG: 'ru_RU.UTF-8',
      LC_ALL: '',
      LC_MESSAGES: '',
      TERM: 'xterm-256color',
    },
    columns: 10,
    rows: 48,
  });
  const narrowResult = await narrow.done;
  const compact = stripVTControlCharacters(narrow.output());

  assert.equal(narrowResult.code, 0);
  assert.doesNotMatch(narrow.output(), /\x1b\[47m/u);
  assert.ok(compact.replaceAll(/\s/gu, '').includes('GRIGDESK:PAIR:1:fixture'));
  assertRestored(narrowResult, narrow.output());
});
