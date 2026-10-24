import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { assertRestored, startPty } from './helpers/pty.mts';
import {
  sourceMenu, launchMenu, menuTitle, requiredApi, visibleLines,
} from './helpers/menuFixture.mts';

const menuScreenEnd = menuTitle;

/**
 * Сопоставляет листья и параметры двух общих каталогов, не дублируя переводы в тесте.
 * Именованные параметры должны совпадать независимо от языка подписи.
 */
function leaves(value: Record<string, unknown>, prefix = ''): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const [key, text] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;

    if (typeof text === 'string') {
      result[name] = [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!).sort();
    } else {
      Object.assign(result, leaves(text as Record<string, unknown>, name));
    }
  }

  return result;
}

test('CM-LOCALE: ru/en одинаковы, приоритет LC_ALL → LC_MESSAGES → LANG и fallback', async () => {
  const translator = await requiredApi('cli/i18n.ts', 'cliTranslator');
  const ru = JSON.parse(await readFile(new URL('../../shared/i18n/assets/locales/ru/cli.json',
    import.meta.url), 'utf8'));
  const en = JSON.parse(await readFile(new URL('../../shared/i18n/assets/locales/en/cli.json',
    import.meta.url), 'utf8'));

  assert.ok(Object.keys(leaves(ru)).length > 0);
  assert.deepEqual(leaves(ru), leaves(en));

  for (const [env, locale] of [
    [{
      LC_ALL: 'en_US.UTF-8',
      LC_MESSAGES: 'ru_RU.UTF-8',
      LANG: 'ru',
    }, 'en'],
    [{
      LC_ALL: '',
      LC_MESSAGES: 'ru_RU.UTF-8',
      LANG: 'en',
    }, 'ru'],
    [{ LANG: 'ru_RU.UTF-8' }, 'ru'],
    [{}, 'ru'],
    [{ LANG: 'C' }, 'en'],
    [{ LANG: 'de_DE.UTF-8' }, 'en'],
  ] as const) {
    assert.equal(translator(env).locale, locale);
  }
});

test('CM-HEADER: компактная шапка, версия и короткие состояния без открытия', async (t) => {
  const box = await sourceMenu(t);
  const session = launchMenu(t, box);

  await session.wait(menuTitle);
  assert.doesNotMatch(session.output(), /█/u);
  assert.match(session.output(), /GrigDesk/u);
  assert.match(session.output(), /ПРИЛОЖЕНИЕ/u);
  assert.match(session.output(), /РАЗРАБОТЧИКУ/u);
  assert.ok(session.output().includes((await readFile(path.join(box.root, 'VERSION'), 'utf8')).trim()));
  assert.match(session.output(), /исходник/iu);
  assert.match(session.output(), /сервер/iu);
  assert.match(session.output(), /окно/iu);
  assert.ok(!box.calls().some((call) => call.startsWith('app ')));
  assert.ok(!box.calls().some((call) => /docker|journalctl/u.test(call)));
  session.write('\x1b');
  assert.equal((await session.done).code, 0);
});

test('CM-HEADER: ожидание зависших systemctl и HTTP не задерживает меню более секунды', async (t) => {
  const box = await sourceMenu(t);
  const release = box.hold();

  t.after(release);
  await box.serve('hang');

  const session = launchMenu(t, box);

  // Отсчёт начинается с первой внешней пробы, когда bash и Node уже запущены.
  // Ранний выход старого CLI проверяется как отсутствие меню, без ожидания службы.
  await box.waitFor(() => box.requests().length > 0 ||
    box.calls().some((call) => call.startsWith('systemctl ')) || session.finished());

  const started = performance.now();

  await session.wait(menuScreenEnd, 1000);

  const elapsed = performance.now() - started;

  t.diagnostic(`Ожидание проб и полного меню: ${Math.round(elapsed)} мс`);
  assert.ok(elapsed <= 1000, `Ожидание проб заняло ${Math.round(elapsed)} мс`);
  assert.ok(box.requests().length > 0, 'HTTP-проба не была запущена');
  assert.ok(box.calls().some((call) => call.startsWith('systemctl ')), 'systemctl не был запущен');
  session.write('\x1b');
  await session.done;
});

for (const [key, code] of [['\x1b', 0], ['\x03', 130]] as const) {
  test(`CM-TERM: выход клавишей ${JSON.stringify(key)}, восстановление termios`, async (t) => {
    const box = await sourceMenu(t);
    const session = launchMenu(t, box);

    await session.wait(menuTitle);
    session.write(key);

    const result = await session.done;

    assert.equal(result.code, code);
    assertRestored(result, session.output());
  });
}

test('CM-TERM: SIGTERM восстанавливает терминал и даёт 143', async (t) => {
  const box = await sourceMenu(t);
  const session = launchMenu(t, box);

  await session.wait(menuTitle);
  session.signal('SIGTERM');

  const result = await session.done;

  assert.equal(result.code, 143);
  assertRestored(result, session.output());
});

for (const mode of ['NO_COLOR', 'dumb', 'normal']) {
  test(`CM-WIDTH: 100 → 40 колонок, resize и ${mode}`, async (t) => {
    const box = await sourceMenu(t);
    const env = {
      ...box.environment,
      LC_ALL: '',
      LC_MESSAGES: '',
      LANG: 'ru_RU.UTF-8',
      TERM: mode === 'dumb' ? 'dumb' : 'xterm',
      ...(mode === 'NO_COLOR' ? { NO_COLOR: '1' } : {}),
    };
    const session = startPty(t, {
      argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl')],
      env,
      columns: 100,
    });

    await session.wait(menuTitle);
    assert.ok(visibleLines(session.output()).every((line) => [...line].length <= 100));

    const before = session.output().length;

    session.resize(40);
    await box.waitFor(() => session.output().length > before);

    const compact = session.output().slice(before);

    assert.match(compact, /GrigDesk/u);
    assert.match(compact, /Сервер/u);
    assert.match(compact, /Окно/u);
    assert.ok(visibleLines(compact).every((line) => [...line].length <= 40), compact);

    if (mode !== 'normal') {
      assert.doesNotMatch(session.output(), /\x1b\[[\d;]*m/u);
    }

    session.write('\x1b');
    assertRestored(await session.done, session.output());
  });
}

test('CM-INSTALL: исходники без ELF показывают build/dev', async (t) => {
  const box = await sourceMenu(t);
  const session = launchMenu(t, box);

  await session.wait(menuScreenEnd);
  assert.match(session.output(), /Сборка/u);
  assert.match(session.output(), /Разработка/u);
  session.write('\x1b');
  await session.done;
});

test('CM-INSTALL: исходники с исправным установленным ELF показывают build/dev', async (t) => {
  const { binaryFixture } = await import('../server/helpers/ctlBinaryFixture.js');
  const { cp, mkdir, symlink } = await import('node:fs/promises');
  const { repository } = await import('./helpers/menuFixture.mts');
  const box = await binaryFixture(t);

  for (const marker of ['server/src/app.ts', 'web/package.json', 'desktop/package.json']) {
    await mkdir(path.dirname(path.join(box.root, marker)), { recursive: true });
    await writeFile(path.join(box.root, marker), '{}');
  }

  for (const name of ['cli', 'shared', 'server/src/lib/runtimePaths.ts',
    'server/src/lib/runtimeBuildContext.ts', 'VERSION']) {
    await cp(path.join(repository, name), path.join(box.root, name), { recursive: true });
  }

  await writeFile(path.join(box.root, 'bin/grigdesk-app'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  await symlink(process.execPath, path.join(box.env.PATH, 'node'));
  await cp(path.join(repository, 'VERSION'), path.join(box.runtime, 'VERSION'));

  const descriptor = path.join(box.home, '.local/share/grigdesk/desktop/runtime.json');

  await mkdir(path.dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({
    version: 1,
    root: box.root,
    node: process.execPath,
  }));

  const session = startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl')],
    env: {
      ...box.env,
      LANG: 'ru_RU.UTF-8',
      DISPLAY: ':99',
    },
  });

  await session.wait(menuScreenEnd);
  assert.match(session.output(), /Сборка/u);
  assert.match(session.output(), /Разработка/u);
  session.write('\x1b');
  await session.done;
});

for (const outcome of ['return', 'exception', 'eof']) {
  test(`CM-TERM: lifecycle сессии при ${outcome} восстанавливает исходный терминал`, async (t) => {
    await requiredApi('cli/terminal.ts', 'TerminalSession');

    const box = await sourceMenu(t);
    const runner = path.join(box.home, 'terminal-lifecycle.mts');
    const module = new URL('../../cli/terminal.ts', import.meta.url).href;

    await writeFile(runner, [
      `import { TerminalSession } from ${JSON.stringify(module)};`,
      'const session = new TerminalSession({ input: process.stdin, output: process.stdout });',
      'try {',
      '  await session.run(async () => {',
      '    console.log("session-ready");',
      outcome === 'exception' ? '    throw new Error("fixture-exception");' : '',
      outcome === 'eof' ? [
        '    await new Promise((resolve) => {',
        '      process.stdin.once("end", resolve);',
        '      process.stdin.emit("end");',
        '    });',
      ].join('\n') : '',
      '  });',
      '} catch (error) {',
      '  if (error.message !== "fixture-exception") throw error;',
      '}',
    ].join('\n'));

    const session = startPty(t, {
      argv: [process.execPath, runner],
      env: box.environment,
    });
    const result = await session.done;

    assert.equal(result.code, 0, session.output());
    assert.match(session.output(), /session-ready/u);
    assertRestored(result, session.output());
  });
}
