import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BASH_PROBE_TIMEOUT_MS,
  decodeBashProbe,
  probeBashEnvironment,
  resolveBashShell,
} from '../../server/src/lib/providerInstall/bashEnvironment.ts';

const NONCE = 'fixture-nonce';

/**
 * Стенд поднимает собственный HOME, собственный внешний Node/npm и серверный
 * PATH с чужим nvm-каталогом: настоящие rc владельца не читаются.
 */
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-bash-env-'));
  const home = path.join(root, 'home');
  const external = path.join(root, 'external', 'bin');
  const server = path.join(root, 'server', 'nvm', 'bin');
  const scratch = path.join(root, 'scratch');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const directory of [home, external, server, scratch]) {
    await fs.mkdir(directory, { recursive: true });
  }

  for (const directory of [external, server]) {
    for (const name of ['node', 'npm']) {
      await fs.writeFile(path.join(directory, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  }

  const env = {
    PATH: `${server}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    USER: 'fixture',
    LOGNAME: 'fixture',
    SHELL: options.shell ?? '/bin/bash',
    LANG: 'C.UTF-8',
    BASH_ENV: path.join(home, 'must-not-run'),
    npm_config_prefix: path.join(root, 'data', 'state', 'npm-global'),
    GRIGDESK_ENV_FILE: path.join(root, 'server.env'),
  };
  const roots = {
    dataHome: path.join(root, 'data'),
    installationRoot: path.join(root, 'installation'),
    runtimeRoot: path.join(root, 'runtime'),
  };

  return {
    root,
    home,
    external,
    server,
    scratch,
    env,
    roots,
  };
}

const probe = (stand, overrides = {}) => probeBashEnvironment({
  env: stand.env,
  roots: stand.roots,
  cliName: 'fixture-cli',
  scratch: stand.scratch,
  nonce: NONCE,
  timeoutMs: 8000,
  ...overrides,
});

test('серверный PATH не доказывает runtime внешней оболочки', async (t) => {
  const stand = await fixture(t);

  await fs.writeFile(path.join(stand.home, '.bashrc'), 'export PS1="> "\n');

  const report = await probe(stand);

  assert.equal(report.shell, 'bash');
  assert.equal(report.failed, false);
  assert.equal(report.interactive?.node.path.startsWith(stand.server), false);
  assert.equal(report.interactive?.npm.path.startsWith(stand.server), false);
  assert.equal(report.interactive?.cli.kind, 'missing');
  assert.equal(report.interactive?.path.includes(stand.server), false);
});

test('startup-файлы сами добавляют runtime, и обе формы находят его', async (t) => {
  const stand = await fixture(t);
  const line = `export PATH="${stand.external}:$PATH"\n`;

  await fs.writeFile(path.join(stand.home, '.bashrc'), line);
  await fs.writeFile(path.join(stand.home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  const report = await probe(stand);

  assert.equal(report.failed, false);
  assert.deepEqual(report.interactive?.node, { kind: 'file', path: path.join(stand.external, 'node') });
  assert.deepEqual(report.login?.npm, { kind: 'file', path: path.join(stand.external, 'npm') });
  assert.equal(report.interactive?.path.split(':')[0], stand.external, 'HOME startup не применён');
});

test('протокол не зависит от шума startup и чужого BASH_ENV', async (t) => {
  const stand = await fixture(t);
  const injected = path.join(stand.home, 'must-not-run');

  await fs.writeFile(injected, 'export PATH="/injected:$PATH"\n');
  await fs.writeFile(path.join(stand.home, '.bashrc'),
    `echo "привет из rc"\nprintf '\\nмусор\\n'\nexport PATH="${stand.external}:$PATH"\n`);

  const report = await probe(stand);

  assert.equal(report.failed, false);
  assert.equal(report.interactive?.path.includes('/injected'), false, 'BASH_ENV выполнился');
  assert.equal(report.interactive?.node.kind, 'file');
});

test('alias и function не считаются командой для автоматической npm-ветки', async (t) => {
  const stand = await fixture(t);

  await fs.writeFile(path.join(stand.home, '.bashrc'), [
    `export PATH="${stand.external}:$PATH"`,
    'alias npm="echo aliased"',
    'node() { :; }',
    '',
  ].join('\n'));

  const report = await probe(stand);

  assert.equal(report.interactive?.npm.kind, 'alias');
  assert.equal(report.interactive?.npm.path, '');
  assert.equal(report.interactive?.node.kind, 'function');
  assert.equal(report.interactive?.node.path, '');
  assert.equal(report.interactive?.prefix, '');
});

test('effective prefix приходит из выбранного npm в оболочке', async (t) => {
  const stand = await fixture(t);
  const prefix = path.join(stand.root, 'shell-prefix');

  await fs.writeFile(path.join(stand.external, 'npm'), [
    '#!/bin/sh',
    `if [ "$1" = "prefix" ]; then printf '%s\\n' ${JSON.stringify(prefix)}; fi`,
    '',
  ].join('\n'), { mode: 0o755 });
  await fs.writeFile(path.join(stand.home, '.bashrc'), `export PATH="${stand.external}:$PATH"\n`);

  const report = await probe(stand);

  assert.equal(report.interactive?.prefix, prefix);
});

test('неподдержанная оболочка не запускается', async (t) => {
  const stand = await fixture(t, { shell: '/bin/zsh' });

  await fs.writeFile(path.join(stand.home, '.zshrc'), 'export PATH="/zsh-only:$PATH"\n');

  const report = await probe(stand);

  assert.equal(report.shell, 'other');
  assert.equal(report.interactive, null);
  assert.equal(report.failed, false);
  assert.equal(await resolveBashShell(stand.env), null);
});

test('ссылка на bash остаётся поддержанной оболочкой', async (t) => {
  const stand = await fixture(t);
  const link = path.join(stand.root, 'my-shell');

  await fs.symlink('/bin/bash', link);

  assert.equal(await resolveBashShell({ ...stand.env, SHELL: link }), link);

  const report = await probeBashEnvironment({
    env: { ...stand.env, SHELL: link },
    roots: stand.roots,
    cliName: 'fixture-cli',
    scratch: stand.scratch,
    nonce: NONCE,
    timeoutMs: 8000,
  });

  assert.equal(report.shell, 'bash');
  assert.equal(report.failed, false);
});

test('зависший startup честно помечает probe неудачным и не висит', async (t) => {
  const stand = await fixture(t);
  const started = Date.now();

  await fs.writeFile(path.join(stand.home, '.bashrc'), 'exec sleep 30\n');

  const report = await probe(stand, { timeoutMs: 300 });

  assert.equal(report.failed, true);
  assert.equal(report.interactive, null);
  assert.ok(Date.now() - started < 5000, 'probe пережил собственный таймаут');
});

test('отмена probe не оставляет ожидания', async (t) => {
  const stand = await fixture(t);
  const controller = new AbortController();
  const started = Date.now();

  await fs.writeFile(path.join(stand.home, '.bashrc'), 'exec sleep 30\n');
  setTimeout(() => controller.abort(), 200);

  const report = await probe(stand, { signal: controller.signal, timeoutMs: BASH_PROBE_TIMEOUT_MS });

  assert.equal(report.failed, true);
  assert.ok(Date.now() - started < 8000);
});

test('повреждённый протокол не превращается в готовый runtime', async (t) => {
  const valid = Buffer.from([
    'grigdesk-bash-probe-1', NONCE, 'ok', '/usr/bin:/bin',
    'file', '/usr/bin/node', 'file', '/usr/bin/npm', 'missing', '', '/usr/local',
  ].join('\0') + '\0');

  const decoded = decodeBashProbe(valid, NONCE);

  assert.equal(decoded.path, '/usr/bin:/bin');
  assert.equal(decoded.cli.kind, 'missing');
  assert.equal(decoded.prefix, '/usr/local');

  const broken = [
    Buffer.from(valid).toString('utf8').replace('grigdesk-bash-probe-1', 'other-version'),
    Buffer.from(valid).toString('utf8').replace(NONCE, 'other-nonce'),
    `${['grigdesk-bash-probe-1', NONCE, 'ok', '/bin', 'file', '/bin/node'].join('\0')}\0`,
    `${[...Array(12).keys()].map((index) => String(index)).join('\0')}\0`,
    valid.toString('utf8').replace('file\0/usr/bin/node', 'weird\0/usr/bin/node'),
    Buffer.alloc(65 * 1024, 'a'),
  ];

  for (const payload of broken) {
    assert.equal(decodeBashProbe(Buffer.from(payload), NONCE), null);
  }

  assert.equal(decodeBashProbe(Buffer.from(''), NONCE), null);
});
