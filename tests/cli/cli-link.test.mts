import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEGACY } from '../../shared/runtime/legacyBrand.ts';
import { completed } from './helpers/sandbox.mts';

const helper = fileURLToPath(new URL('../../deploy/lib/cli-link.sh', import.meta.url));

/**
 * Вызывает только функцию ссылки с позиционными аргументами, без shell-интерполяции путей.
 * Все файлы находятся в отдельном временном каталоге, пользовательский PATH не меняется.
 */
function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-link-'));
  const root = path.join(home, 'корень с пробелами');
  const bin = path.join(home, 'local/bin');

  t.after(() => rmSync(home, {
    recursive: true,
    force: true,
  }));
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'bin/grigdesk-ctl'), '#!/bin/bash\nexit 0\n');

  return {
    root,
    bin,
    run: () => completed(spawn('bash', ['-c',
      'source "$1"; grigdesk_link_cli "$2" "$3"', 'test', helper, root, bin])),
  };
}

test('CL-1 каталог создаётся и ссылка ведёт в текущую копию', async (t) => {
  const box = fixture(t);
  const result = await box.run();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(readlinkSync(path.join(box.bin, 'grigdesk-ctl')), path.join(box.root, 'bin/grigdesk-ctl'));
});

test('CL-2 ссылка на другую копию заменяется', async (t) => {
  const box = fixture(t);

  mkdirSync(box.bin, { recursive: true });
  symlinkSync('/example/old/bin/grigdesk-ctl', path.join(box.bin, 'grigdesk-ctl'));

  const result = await box.run();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(readlinkSync(path.join(box.bin, 'grigdesk-ctl')), path.join(box.root, 'bin/grigdesk-ctl'));
});

test('CL-3 чужой обычный файл сохраняется', async (t) => {
  const box = fixture(t);
  const file = path.join(box.bin, 'grigdesk-ctl');

  mkdirSync(box.bin, { recursive: true });
  writeFileSync(file, 'чужая команда');

  const result = await box.run();

  assert.equal(result.code, 1);
  assert.match(result.stderr, /не перезаписан|не заменён/);
  assert.equal(readFileSync(file, 'utf8'), 'чужая команда');
});

test('CL-4 прежние имена команды убираются только как ссылки на эту копию', async (t) => {
  const box = fixture(t);

  mkdirSync(box.bin, { recursive: true });
  symlinkSync(path.join(box.root, 'bin/grigdesk'), path.join(box.bin, 'grigdesk'));
  symlinkSync(path.join(box.root, 'bin', LEGACY.cliLink), path.join(box.bin, LEGACY.cliLink));

  assert.equal((await box.run()).code, 0);
  // Обе ссылки висячие: проверяем саму ссылку, а не файл, на который она указывает.
  assert.throws(() => lstatSync(path.join(box.bin, 'grigdesk')), /ENOENT/);
  assert.throws(() => lstatSync(path.join(box.bin, LEGACY.cliLink)), /ENOENT/);

  // Ссылка на другую копию и чужой файл с прежним именем не трогаются.
  symlinkSync('/example/other/bin/grigdesk', path.join(box.bin, 'grigdesk'));
  writeFileSync(path.join(box.bin, LEGACY.cliLink), 'чужая команда');

  assert.equal((await box.run()).code, 0);
  assert.equal(readlinkSync(path.join(box.bin, 'grigdesk')), '/example/other/bin/grigdesk');
  assert.equal(readFileSync(path.join(box.bin, LEGACY.cliLink), 'utf8'), 'чужая команда');
});

test('CL-5 Bash берёт прежнее имя команды из единого контракта', () => {
  const source = readFileSync(helper, 'utf8');

  assert.equal(source.match(/local legacy_cli='([^']+)'/)?.[1], LEGACY.cliLink);
});
