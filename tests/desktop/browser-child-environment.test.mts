import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import { cleanDesktopChildEnvironment } from '../../desktop/src/childEnvironment.ts';
import { buildServerEnv } from '../../desktop/src/runtimeConfig.ts';

const run = promisify(execFile);

/**
 * Synthetic AppRun env включает exported APPDIR и отдельный unpacked appDir.
 * Пути с похожим префиксом остаются, чтобы cleanup не удалял обычные OS каталоги.
 */
function sourceEnvironment() {
  return {
    PATH: '/fixture/app:/fixture/app/bin:/fixture/app-other/bin:/usr/bin:/bin',
    APPDIR: '/fixture/app',
    APPIMAGE: '/fixture/window.AppImage',
    ELECTRON_RUN_AS_NODE: '1',
    CHROME_DESKTOP: 'window.desktop',
    LD_LIBRARY_PATH: '/fixture/app/usr/lib:/fixture/unpacked/usr/lib:/usr/lib/extra',
    XDG_DATA_DIRS: '/fixture/app/usr/share:/usr/share',
    GSETTINGS_SCHEMA_DIR: '/fixture/unpacked/usr/share/glib-2.0/schemas',
    XDG_CURRENT_DESKTOP: 'temporary',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME',
    LANG: 'C',
    HOME: '/home/user',
  };
}

test('BR-ENV01: одна cleanup policy сохраняет OS paths и server-specific PATH contract', () => {
  const source = sourceEnvironment();
  const before = structuredClone(source);
  const browser = cleanDesktopChildEnvironment(source, '/fixture/unpacked');
  const server = buildServerEnv({
    parent: source,
    dotenv: {},
    node: '/fixture/node/bin/node',
    home: '/home/user',
    appDir: '/fixture/unpacked'
  });

  assert.deepEqual(source, before);
  assert.equal(browser.PATH, '/fixture/app-other/bin:/usr/bin:/bin');
  assert.equal(browser.LD_LIBRARY_PATH, '/usr/lib/extra');
  assert.equal(browser.XDG_DATA_DIRS, '/usr/share');
  assert.equal(browser.XDG_CURRENT_DESKTOP, 'GNOME');
  assert.equal(Object.hasOwn(browser, 'GSETTINGS_SCHEMA_DIR'), false);
  assert.equal(Object.hasOwn(browser, 'APPDIR'), false);
  assert.equal(Object.hasOwn(browser, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(Object.hasOwn(browser, 'GRIGDESK_DESKTOP_CHILD'), false);
  assert.equal(server.GRIGDESK_DESKTOP_CHILD, '1');
  assert.equal(server.PATH?.startsWith('/home/user/.kimi-code/bin:/home/user/.local/bin:'), true);
  assert.equal(server.LD_LIBRARY_PATH, browser.LD_LIBRARY_PATH);
  assert.equal(server.XDG_DATA_DIRS, browser.XDG_DATA_DIRS);
});

test('BR-ENV02: настоящий external child видит clean env без AppImage loader paths', async () => {
  const env = cleanDesktopChildEnvironment(sourceEnvironment(), '/fixture/unpacked');
  const code = [
    'const names=["PATH","APPDIR","ELECTRON_RUN_AS_NODE","LD_LIBRARY_PATH",',
    '"XDG_DATA_DIRS","GSETTINGS_SCHEMA_DIR","XDG_CURRENT_DESKTOP"];',
    'console.log(JSON.stringify(Object.fromEntries(names.map(name=>[name,process.env[name]??null]))));',
  ].join('\n');
  const { stdout } = await run(process.execPath, ['-e', code], { env, timeout: 5000 });
  const actual = JSON.parse(stdout);

  assert.deepEqual(actual, {
    PATH: '/fixture/app-other/bin:/usr/bin:/bin',
    APPDIR: null,
    ELECTRON_RUN_AS_NODE: null,
    LD_LIBRARY_PATH: '/usr/lib/extra',
    XDG_DATA_DIRS: '/usr/share',
    GSETTINGS_SCHEMA_DIR: null,
    XDG_CURRENT_DESKTOP: 'GNOME',
  });
});
