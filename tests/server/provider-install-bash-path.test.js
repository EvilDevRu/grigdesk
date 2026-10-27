import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BLOCK_END,
  BLOCK_START,
  applyManagedBlock,
  bashPathBlock,
  chooseDirectoryOrder,
  externalDirectories,
  findManagedBlock,
  planBashPath,
  writeBashPathPlan,
} from '../../server/src/lib/providerInstall/bashPath.ts';
import { probeBashEnvironment } from '../../server/src/lib/providerInstall/bashEnvironment.ts';
import { EXTERNAL_BASELINE_PATH } from '../../server/src/lib/providerInstall/npmEnvironment.ts';

/**
 * Стенд держит HOME, внешний bin и D/I/R во временных папках.
 * Настоящие rc владельца не читаются и не меняются.
 */
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-bash-path-'));
  const home = path.join(root, 'home');
  const external = path.join(root, 'external');
  const scratch = path.join(root, 'scratch');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const directory of [home, external, scratch]) {
    await fs.mkdir(directory, { recursive: true });
  }

  await fs.symlink(process.execPath, path.join(external, 'node'));

  return {
    root,
    home,
    external,
    scratch,
    roots: {
      dataHome: path.join(root, 'data'),
      installationRoot: path.join(root, 'installation'),
      runtimeRoot: path.join(root, 'runtime'),
    },
  };
}

async function executable(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function shellProbe(stand, cliName = 'fixture-cli') {
  return probeBashEnvironment({
    env: {
      PATH: EXTERNAL_BASELINE_PATH,
      HOME: stand.home,
      SHELL: '/bin/bash',
      LANG: 'C.UTF-8',
    },
    roots: stand.roots,
    cliName,
    scratch: stand.scratch,
    nonce: 'bash-path-nonce',
    timeoutMs: 8000,
  });
}

test('блок объединяет каталоги, идемпотентен и не теряет чужой PATH', async (t) => {
  const stand = await fixture(t);
  const spaced = path.join(stand.root, 'Мои файлы', 'bin');

  await fs.mkdir(spaced, { recursive: true });

  const block = bashPathBlock(['/opt/a/bin', spaced]);
  const applied = applyManagedBlock('export PATH="/usr/bin:$PATH"\n', block);

  assert.match(block, new RegExp(BLOCK_START.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(block, new RegExp(BLOCK_END.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.ok(block.includes(`'${spaced}'`), 'каталог с пробелом не экранирован');
  assert.equal(findManagedBlock(applied).start >= 0, true);
  assert.equal(applyManagedBlock(applied, block), applied, 'повтор блока изменил файл');
  assert.ok(applied.startsWith('export PATH="/usr/bin:$PATH"\n'));

  const removed = externalDirectories([
    '/opt/a/bin', '/opt/a/bin', stand.roots.dataHome, stand.roots.runtimeRoot,
    'relative/bin',
  ], stand.roots);

  assert.deepEqual(removed, ['/opt/a/bin']);
});

test('login-файл выбирается по существующей цепочке без нового .bash_profile', async (t) => {
  const stand = await fixture(t);
  const directories = ['/opt/a/bin'];

  const created = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories,
  });

  assert.equal(created.status, 'ok');
  assert.deepEqual(created.changes.map((change) => [path.basename(change.file), change.action]),
    [['.bashrc', 'create'], ['.profile', 'create']]);

  await fs.writeFile(path.join(stand.home, '.profile'), '# login\n');

  const withProfile = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories,
  });

  assert.equal(withProfile.changes[1].file, path.join(stand.home, '.profile'));

  await fs.writeFile(path.join(stand.home, '.bash_profile'), '# profile\n');

  const withProfileFile = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories,
  });

  assert.equal(withProfileFile.changes[1].file, path.join(stand.home, '.bash_profile'));
  assert.equal(await fs.stat(path.join(stand.home, '.bash_profile')).then(() => true), true);
});

test('прежний блок заменяется на своём месте, повреждённый — конфликт', async (t) => {
  const stand = await fixture(t);
  const bashrc = path.join(stand.home, '.bashrc');

  await fs.writeFile(bashrc, '# до\nexport A=1\n');
  await fs.writeFile(path.join(stand.home, '.profile'), '# login\n');

  const first = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: ['/opt/a/bin'],
  });

  assert.equal((await writeBashPathPlan(first)).status, 'written');

  const midBlock = `# между\n${(await fs.readFile(bashrc, 'utf8')).trimEnd()}\n# после\n`;

  await fs.writeFile(bashrc, midBlock);

  const second = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: ['/opt/b/bin'],
  });

  assert.equal((await writeBashPathPlan(second)).status, 'written');

  const text = await fs.readFile(bashrc, 'utf8');

  assert.ok(text.includes('/opt/b/bin'));
  assert.equal(text.includes('/opt/a/bin'), false, 'неактивный каталог остался в блоке');
  assert.ok(text.indexOf('# между') < text.indexOf(BLOCK_START));
  assert.equal(text.trimEnd().endsWith(BLOCK_END), false, 'хвост файла потерян');
  assert.ok(text.trimEnd().endsWith('# после'));


  await fs.writeFile(bashrc, `${BLOCK_START}\nмусор\n${BLOCK_START}\n${BLOCK_END}\n`);

  const broken = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: ['/opt/c/bin'],
  });

  assert.equal(broken.status, 'conflict');
  assert.equal(broken.changes.length, 0);
});

test('символьная ссылка и необычный файл — ручная настройка', async (t) => {
  const stand = await fixture(t);
  const real = path.join(stand.root, 'dotfiles-bashrc');

  await fs.writeFile(real, '# real\n');
  await fs.symlink(real, path.join(stand.home, '.bashrc'));

  const linked = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: ['/opt/a/bin'],
  });

  assert.equal(linked.status, 'manual');
  assert.equal(linked.reason, 'shell_rc_symlink');
  assert.equal((await fs.readFile(real, 'utf8')), '# real\n');

  await fs.rm(path.join(stand.home, '.bashrc'));
  await fs.mkdir(path.join(stand.home, '.bashrc'));

  const directory = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: ['/opt/a/bin'],
  });

  assert.equal(directory.status, 'manual');
});

test('writer сохраняет mode файла и не меняет mode HOME', async (t) => {
  const stand = await fixture(t);
  const bashrc = path.join(stand.home, '.bashrc');

  await fs.writeFile(bashrc, '# старый\n', { mode: 0o640 });
  await fs.chmod(stand.home, 0o751);

  const plan = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: ['/opt/a/bin'],
  });
  const result = await writeBashPathPlan(plan);

  assert.equal(result.status, 'written');
  assert.equal((await fs.stat(bashrc)).mode & 0o777, 0o640);
  assert.equal((await fs.stat(stand.home)).mode & 0o777, 0o751);
  assert.equal((await fs.stat(path.join(stand.home, '.profile'))).mode & 0o777, 0o644);
  await fs.chmod(stand.home, 0o755);
});

test('конкурентная правка и read-only файл не перезаписываются', async (t) => {
  const stand = await fixture(t);
  const bashrc = path.join(stand.home, '.bashrc');

  await fs.writeFile(bashrc, '# старый\n');
  await fs.writeFile(path.join(stand.home, '.profile'), '# login\n');

  const plan = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: ['/opt/a/bin'],
  });

  await fs.writeFile(bashrc, '# человек\n');

  assert.equal((await writeBashPathPlan(plan)).status, 'changed');
  assert.equal(await fs.readFile(bashrc, 'utf8'), '# человек\n');

  await fs.writeFile(bashrc, '# только чтение\n', { mode: 0o444 });
  await fs.chmod(bashrc, 0o444);

  const readonlyPlan = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: ['/opt/a/bin'],
  });

  assert.equal(readonlyPlan.status, 'manual');
  assert.equal(readonlyPlan.reason, 'shell_rc_readonly');
  assert.equal(await fs.readFile(bashrc, 'utf8'), '# только чтение\n');

  const leftovers = (await fs.readdir(stand.home)).filter((name) => name.endsWith('.tmp'));

  assert.deepEqual(leftovers, []);
  await fs.chmod(bashrc, 0o644);
});

test('порядок каталогов проверяется разрешением имён', async (t) => {
  const stand = await fixture(t);
  const first = path.join(stand.root, 'first', 'bin');
  const second = path.join(stand.root, 'second', 'bin');

  await executable(path.join(first, 'claude'));
  await executable(path.join(second, 'codex'));

  const selected = await chooseDirectoryOrder({
    added: second,
    existing: [first],
    bindings: [{ name: 'claude', directory: first }, { name: 'codex', directory: second }],
  });

  assert.equal(selected.conflict, false);
  assert.deepEqual(selected.order, [path.resolve(second), path.resolve(first)]);

  await executable(path.join(first, 'codex'));
  await executable(path.join(second, 'claude'));

  const impossible = await chooseDirectoryOrder({
    added: second,
    existing: [first],
    bindings: [{ name: 'claude', directory: first }, { name: 'codex', directory: second }],
  });

  assert.equal(impossible.conflict, true);
});

test('настоящий Bash находит и буквально запускает установленный CLI', async (t) => {
  const stand = await fixture(t);
  const prefix = path.join(stand.root, 'Мои файлы');
  const bin = path.join(prefix, 'bin');
  const cliName = 'fixture-cli';
  const cli = path.join(bin, cliName);

  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(cli,
    '#!/usr/bin/env node\nprocess.stdout.write(`${process.env.FIXTURE_ARG || "cli"} 9.9.9\\n`);\n',
    { mode: 0o755 });
  await fs.writeFile(path.join(stand.home, '.bashrc'),
    `export PATH="${stand.external}:$PATH"\nexport FIXTURE_ARG=ready\n`);
  await fs.writeFile(path.join(stand.home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  const before = await shellProbe(stand, cliName);

  assert.equal(before.interactive?.cli.kind, 'missing', 'CLI нашёлся до настройки');
  assert.equal(before.interactive?.node.kind, 'file');

  const plan = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: [bin],
  });

  assert.equal(plan.status, 'ok');
  assert.equal((await writeBashPathPlan(plan)).status, 'written');

  const after = await shellProbe(stand, cliName);

  assert.equal(after.interactive?.cli.kind, 'file');
  assert.equal(after.interactive?.cli.path, cli);
  assert.equal(after.login?.cli.path, cli);

  const env = {
    PATH: EXTERNAL_BASELINE_PATH,
    HOME: stand.home,
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
  };
  const launched = spawnSync('/bin/bash', ['-ic', `${cliName} --version`], { env, encoding: 'utf8' });
  const loginLaunched = spawnSync('/bin/bash', ['-lic', `${cliName} --version`], { env, encoding: 'utf8' });

  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout.trim(), 'ready 9.9.9');
  assert.equal(loginLaunched.stdout.trim(), 'ready 9.9.9');

  const pathLine = spawnSync('/bin/bash', ['-ic', 'printf %s "$PATH"'], { env, encoding: 'utf8' });

  assert.ok(pathLine.stdout.split(':')[0].includes('Мои файлы'));
  assert.equal(pathLine.stdout.split(':').filter((entry) => entry === bin).length, 1);
});

test('ранний return в rc не выдаётся за готовый терминал', async (t) => {
  const stand = await fixture(t);
  const bin = path.join(stand.root, 'p', 'bin');

  await executable(path.join(bin, 'fixture-cli'));
  await fs.writeFile(path.join(stand.home, '.bashrc'),
    `export PATH="${stand.external}:$PATH"\nreturn 0\nexport PATH="${bin}:$PATH"\n`);

  const plan = await planBashPath({
    home: stand.home,
    roots: stand.roots,
    directories: [bin],
  });

  await writeBashPathPlan(plan);

  const report = await shellProbe(stand);

  assert.equal(report.interactive?.cli.kind, 'missing', 'блок после return объявлен рабочим');
});
