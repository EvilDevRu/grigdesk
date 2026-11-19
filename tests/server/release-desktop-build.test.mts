import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDesktopRelease } from '../../tools/buildDesktopRelease.mts';
import { writeStoredMacZip } from '../helpers/macosZipFixture.mjs';

test('RELEASE-MAC-WINDOW: оконный сборщик возвращает ZIP после проверки app', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gd-desktop-builder-')));
  const outDir = path.join(root, 'out');
  const cacheDir = path.join(root, 'cache');
  const app = path.join(outDir, 'mac-arm64/grigdesk.app');
  const binary = path.join(app, 'Contents/MacOS/grigdesk');
  const releaseId = 'a'.repeat(64);
  const version = '0.2.0-dev.8';
  const env = { GRIGDESK_RELEASE_VERSION: version, GRIGDESK_RELEASE_ID: releaseId };
  const calls = [] as string[];

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(root, 'VERSION'), '0.2.0\n');

  const output = await buildDesktopRelease({
    root,
    outDir,
    cacheDir,
    env,
    target: 'darwin-arm64',
  }, {
    prepareElectron: async () => path.join(cacheDir, 'electron'),
    probe: async (file) => {
      assert.equal(file, binary);

      return JSON.stringify({ version, releaseId });
    },
    /**
     * Подменяет команды ОС и создаёт минимальные файлы на выходах сборщика.
     * Mach-O и структура ZIP по-прежнему проходят настоящие проверки.
     */
    async run(file, args) {
      calls.push(file);

      if (file === 'npm') {
        assert.ok(args.includes('dist:mac'));

        const sample = Buffer.alloc(32);

        sample.writeUInt32LE(0xfeedfacf, 0);
        sample.writeUInt32LE(0x0100000c, 4);
        sample.writeUInt32LE(2, 12);
        await fs.mkdir(path.dirname(binary), { recursive: true });
        await fs.writeFile(binary, sample, { mode: 0o755 });
        await fs.writeFile(path.join(app, 'Contents/Info.plist'), [
          '<key>CFBundleExecutable</key><string>grigdesk</string>',
          '<key>CFBundleShortVersionString</key><string>0.2.0</string>',
          '<key>CFBundleVersion</key><string>0.2.0</string>',
        ].join('\n'));
      } else if (file.endsWith('/plutil')) {
        await fs.copyFile(args[4]!, args[3]!);
      } else if (file.endsWith('/ditto')) {
        assert.deepEqual(args.slice(0, 4), ['-c', '-k', '--sequesterRsrc', '--keepParent']);
        assert.equal(args.at(-2), app);
        await writeStoredMacZip(args.at(-1), [{
          name: 'grigdesk.app/Contents/Info.plist',
          bytes: await fs.readFile(path.join(app, 'Contents/Info.plist')),
          mode: 0o100644,
        }, {
          name: 'grigdesk.app/Contents/MacOS/grigdesk',
          bytes: await fs.readFile(binary),
          mode: 0o100755,
        }]);
      }
    },
  });

  assert.equal(path.basename(output), 'GrigDesk.app.zip');
  assert.equal((await fs.readFile(output)).subarray(0, 2).toString('ascii'), 'PK');
  assert.deepEqual(calls, ['npm', '/usr/bin/codesign', '/usr/bin/plutil', '/usr/bin/ditto']);
});
