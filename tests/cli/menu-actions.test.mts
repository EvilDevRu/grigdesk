import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { assertRestored } from './helpers/pty.mts';
import {
  sourceMenu, launchMenu, menuTitle, down, up, enterGroup, exitMenus,
} from './helpers/menuFixture.mts';

const groups = ['Открыть окно', 'Состояние', 'Сервер', 'Посредник', 'Устройства',
  'Сборка', 'Разработка', 'Уборка артефактов', 'Выход'];

test('MA-NAV: порядок, описания, стрелки, Enter и Esc между уровнями', async (t) => {
  const box = await sourceMenu(t);
  const session = launchMenu(t, box);

  await session.wait(menuTitle);

  const first = session.output();
  let position = -1;

  for (const title of groups) {
    const next = first.indexOf(title, position + 1);

    assert.ok(next > position, `Пункт отсутствует или нарушен порядок: ${title}`);
    position = next;
  }

  assert.match(first, /запустить.*GrigDesk/iu);
  assert.doesNotMatch(first, /привязать телефон по QR/iu);

  const statusStart = session.output().length;

  session.write(down);
  await session.wait(/сервер, окно, посредник, связи/iu, 4000, statusStart);
  assert.doesNotMatch(session.output().slice(statusStart), /запустить.*GrigDesk/iu);
  session.write(up + down.repeat(5) + '\r');
  await session.wait(/Android APK/u);

  const build = session.output().slice(first.length);
  const buildTitles = [/Всё/u, /Только сервер/u, /Только веб/u, /Окно/u, /DeepSeek/u,
    /Android APK/u];

  for (const title of buildTitles) {
    assert.match(build, title);
  }

  assert.match(build, /сервер.*веб.*окно/iu);
  assert.match(build, /\(server, desktop, tasks\)/u);

  const apkStart = session.output().length;

  session.write(down.repeat(5));
  await session.wait(/собрать приложение со встроенным вебом/iu, 4000, apkStart);

  const before = session.output().length;

  session.write('\x1b');
  await box.waitFor(() => menuTitle.test(session.output().slice(before)));
  session.write(down + up + '\x1b');

  const result = await session.done;

  assert.equal(result.code, 0);
  assertRestored(result, session.output());
  assert.ok(!box.calls().some((call) => call.startsWith('app ')));
});

test('MA-OPEN: первый Enter повторяет прежний open и его исход', async (t) => {
  const box = await sourceMenu(t);
  const expected = await box.run(['open']);
  const session = launchMenu(t, box);

  await session.wait(menuTitle);
  session.write('\r');

  const result = await session.done;

  assert.equal(result.code, expected.code);
  await box.waitFor(() => box.calls().filter((call) => call.startsWith('app ')).length === 2);
  assert.ok(box.calls().filter((call) => call.startsWith('app ')).every((call) =>
    call === `app --grigdesk-url=http://127.0.0.1:${box.port}/`));
  assertRestored(result, session.output());
});

for (const [groupIndex, component] of [[2, 'server'], [3, 'relay']] as const) {
  for (const [actionIndex, action] of ['start', 'stop', 'restart', 'logs'].entries()) {
    test(`MA-COMMANDS: ${component} ${action}, прежние argv без follow`, async (t) => {
      const box = await sourceMenu(t);

      // Мастер удалённого доступа добавил setup/restore в начало подменю посредника.
      const itemOffset = component === 'relay' ? 2 : 0;

      if (component === 'server') {
        box.unit({ ActiveState: action === 'start' ? 'inactive' : 'active' });

        if (action !== 'start') {
          await box.serve('grigdesk');
        }
      } else {
        box.docker([`fixture-relay\tfixture\t${box.root}/relay/compose.yaml`],
          action === 'start' ? 'exited\t' : 'running\thealthy');
      }

      const session = launchMenu(t, box);

      await enterGroup(session, groupIndex, /Запустить|Остановить|Перезапустить/u);
      session.write(down.repeat(actionIndex + itemOffset) + '\r');

      const expected = component === 'server'
        ? action === 'logs' ? 'journalctl --user -u grigdesk-server.service -n 100 --no-pager'
          : `systemctl --user ${action}${action === 'start' ? ' --no-block' : ''} grigdesk-server.service`
        : action === 'logs' ? 'docker logs --tail 100 fixture-relay' : `docker ${action} fixture-relay`;

      await box.waitFor(() => box.calls().includes(expected));
      assert.ok(!box.calls().some((call) => /--follow|--force/u.test(call)));
      await exitMenus(session);
    });
  }
}

for (const [index, action] of ['add', 'list', 'revoke'].entries()) {
  test(`MA-COMMANDS: device ${action}, ввод имени/id и прежний HTTP/QR`, async (t) => {
    const box = await sourceMenu(t);
    const requests: { url: string; body: string }[] = [];
    const key = path.join(box.home, 'window-key');

    await writeFile(key, 'fixture-key');
    await writeFile(path.join(box.home, '.grigdesk/.env'),
      `GRIGDESK_PORT=${box.port}\nGRIGDESK_WINDOW_KEY_PATH=${key}\n`);

    const server = createServer(async (request, response) => {
      let body = '';

      for await (const chunk of request) {
        body += chunk.toString();
      }

      requests.push({ url: request.url ?? '', body });
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
        response.end(JSON.stringify({ devices: [], ok: true }));
      }
    });

    await new Promise<void>((resolve) => server.listen(box.port, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const session = launchMenu(t, box);

    await enterGroup(session, 4, /Привязать|Список|Отозвать/u);
    session.write(down.repeat(index) + '\r');

    if (action !== 'list') {
      await session.wait(action === 'add' ? /имя/iu : /id/iu);
      session.write(action === 'add' ? 'ТелефоН\x7fн\r' : 'd123\r');
    }

    const expected = action === 'add' ? '/api/devices/pairing'
      : action === 'list' ? '/api/devices' : '/api/devices/d123/revoke';

    await box.waitFor(() => requests.some((request) => request.url === expected));

    if (action === 'add') {
      assert.deepEqual(JSON.parse(requests.find((request) => request.url === expected)!.body),
        { name: 'Телефон' });
      await session.wait(/GRIGDESK:PAIR:1:fixture/u);
      assert.match(session.output(), /[▀▄█]/u);
    }

    await exitMenus(session);
  });
}

test('MA-COMMANDS: отмена текстового ввода Esc не вызывает device', async (t) => {
  const box = await sourceMenu(t);
  const session = launchMenu(t, box);

  await enterGroup(session, 4, /Привязать/u);
  session.write('\r');
  await session.wait(/имя/iu);
  session.write('Черновик\x1b');
  assert.deepEqual(box.requests(), []);
  session.write('\x1b\x1b');
  assertRestored(await session.done, session.output());
});

for (const [index, action] of ['dev', 'deps', 'run'].entries()) {
  test(`MA-COMMANDS: разработка ${action} делегируется прежней оболочке`, async (t) => {
    const box = await sourceMenu(t);
    const wrapper = path.join(box.root, 'bin/grigdesk-ctl');
    const { rename } = await import('node:fs/promises');

    await rename(wrapper, `${wrapper}.real`);
    await writeFile(wrapper, [
      '#!/bin/bash',
      'if (( $# > 0 )); then',
      '  printf "developer %s\\n" "$*" >> "$STUB_HOME/calls.log"',
      '  exit 7',
      'fi',
      'exec /bin/bash "${BASH_SOURCE[0]}.real"',
    ].join('\n'), { mode: 0o755 });

    const session = launchMenu(t, box);

    await enterGroup(session, 6, /зависимост/iu);
    session.write(down.repeat(index) + '\r');
    await box.waitFor(() => box.calls().includes(`developer ${action}`));

    if (action === 'deps') {
      await exitMenus(session);
    }

    const result = await session.done;

    assert.equal(result.code, action === 'deps' ? 0 : 7);
    assertRestored(result, session.output());
  });
}

for (const [group, actionIndex, action] of [[0, 0, 'open'], [2, 1, 'stop'], [2, 2, 'restart']] as const) {
  test(`MA-GUARD: cgroup меняется после меню, ${action} не обходит сторож`, async (t) => {
    const box = await sourceMenu(t);
    const session = launchMenu(t, box);

    await session.wait(menuTitle);

    if (group) {
      session.write(down.repeat(group) + '\r');
      await session.wait(/Остановить/u);
    }

    const before = box.calls();

    await writeFile(path.join(box.home, 'cgroup'), '0::/user.slice/grigdesk-server.service');
    session.write(down.repeat(actionIndex) + '\r');
    await session.wait(/--force/u);
    assert.deepEqual(box.calls(), before);

    const result = group ? await exitMenus(session) : await session.done;

    assert.equal(result.code, group ? 0 : 1);
    assertRestored(result, session.output());

    if (action === 'open') {
      assert.equal((await box.run(['open', '--force'])).code, 0);
    } else {
      box.unit({ ActiveState: 'active' });
      await box.serve('grigdesk');
      assert.equal((await box.run(['server', action, '--force'])).code, 0);
      assert.ok(box.calls().includes(`systemctl --user ${action} grigdesk-server.service`));
    }
  });
}

test('MA-COMMANDS: Состояние вызывает прежний полный status, включая посредник и связи', async (t) => {
  const box = await sourceMenu(t);

  box.unit({ ActiveState: 'active' });
  box.docker([`fixture-relay\tfixture\t${box.root}/relay/compose.yaml`]);
  await box.serve('grigdesk');

  const session = launchMenu(t, box);

  await session.wait(menuTitle);
  session.write(down + '\r');
  await box.waitFor(() => box.requests().includes('/api/mobile/status'));
  assert.ok(box.calls().some((call) => call.startsWith('docker inspect ')));
  assertRestored(await exitMenus(session), session.output());
});
