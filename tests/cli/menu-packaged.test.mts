import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { sourceMenu, repository, menuTitle, launchMenu } from './helpers/menuFixture.mts';
import { startPty, assertRestored } from './helpers/pty.mts';

for (const kind of ['portable', 'release', 'installed']) {
  for (const locale of ['ru_RU.UTF-8', 'en_US.UTF-8']) {
    test(`MP-MOVED/CM-INSTALL: ${kind}, ${locale}, автономное меню после переноса`, async (t) => {
      const box = await sourceMenu(t);
      const initial = path.join(box.home, 'initial-runtime');
      const moved = path.join(box.home, 'moved-runtime');

      await buildHelper({
        root: repository,
        manifestPath: path.join(repository, 'server/build/helpers.json'),
        id: 'grigdesk-cli',
        outDir: path.join(initial, 'server/runtime/helpers'),
        workDir: path.join(box.home, 'helper-work'),
      });
      await cp(path.join(box.root, 'VERSION'), path.join(initial, 'VERSION'));
      await mkdir(path.join(initial, 'bin'), { recursive: true });
      await cp(path.join(box.root, 'bin/grigdesk-app'), path.join(initial, 'bin/grigdesk-app'));

      if (kind === 'portable') {
        await writeFile(path.join(initial, 'bin/bundle.json'), JSON.stringify({ format: 1, kind }));
        await cp(path.join(box.root, 'bin/grigdesk-app'), path.join(initial, 'GrigDesk'));
      } else if (kind === 'release') {
        await writeFile(path.join(initial, 'release.json'), '{}');
      }

      // Случайные маркеры исходников не должны открывать разработку готовой поставки.
      for (const name of kind === 'installed' ? []
        : ['server/src/app.ts', 'web/package.json', 'desktop/package.json']) {
        await mkdir(path.dirname(path.join(initial, name)), { recursive: true });
        await writeFile(path.join(initial, name), '{}');
      }

      await rename(initial, moved);

      const entry = path.join(moved, 'server/runtime/helpers/grigdesk-cli.mjs');
      const session = startPty(t, {
        argv: [process.execPath, entry],
        env: {
          ...box.environment,
          LC_ALL: '',
          LC_MESSAGES: '',
          LANG: locale,
          TERM: 'xterm',
        },
        cwd: '/',
      });

      await session.wait(menuTitle);
      assert.ok(session.output().includes((await readFile(path.join(moved, 'VERSION'), 'utf8')).trim()));
      assert.doesNotMatch(session.output(), /Сборка|Разработка|Development|Build ›/iu);
      assert.match(session.output(), locale.startsWith('ru') ? /Открыть окно/u : /Open.*window/iu);
      assert.ok(!box.calls().some((call) => call.startsWith('app ')));
      session.write('\r');

      const result = await session.done;

      assert.equal(result.code, 0, session.output());
      assertRestored(result, session.output());
      await box.waitFor(() => box.calls().some((call) => call.startsWith('app ')));

      const expected = kind === 'portable' ? 'app ' : `app --grigdesk-url=http://127.0.0.1:${box.port}/`;

      assert.ok(box.calls().includes(expected));
    });
  }
}

test('MP-MOVED барьер: собранный helper без TTY показывает справку после переноса', async (t) => {
  const box = await sourceMenu(t);
  const initial = path.join(box.home, 'initial-runtime');
  const moved = path.join(box.home, 'moved-runtime');

  await buildHelper({
    root: repository,
    manifestPath: path.join(repository, 'server/build/helpers.json'),
    id: 'grigdesk-cli',
    outDir: path.join(initial, 'server/runtime/helpers'),
    workDir: path.join(box.home, 'helper-work'),
  });
  await cp(path.join(box.root, 'VERSION'), path.join(initial, 'VERSION'));
  await mkdir(path.join(initial, 'bin'), { recursive: true });
  await cp(path.join(box.root, 'bin/grigdesk-app'), path.join(initial, 'bin/grigdesk-app'));
  await rename(initial, moved);

  const session = startPty(t, {
    argv: [process.execPath, path.join(moved, 'server/runtime/helpers/grigdesk-cli.mjs')],
    env: box.environment,
    inputTTY: false,
    outputTTY: false,
  });
  const result = await session.done;

  assert.equal(result.code, 0, session.output());
  assert.doesNotMatch(session.output(), menuTitle);
  assert.match(session.output(), /grigdesk-ctl server start/u);
  assert.deepEqual(box.calls(), []);
  assert.deepEqual(box.requests(), []);
});
