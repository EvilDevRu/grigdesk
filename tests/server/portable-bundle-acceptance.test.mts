import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const bundleDirectory = process.env.GRIGDESK_TEST_BUNDLE_DIR;
const publishedOnly = {
  skip: bundleDirectory ? false : 'NOT RUN: нужен опубликованный GRIGDESK_TEST_BUNDLE_DIR',
  timeout: 600000,
};
const expectedPayload = [
  'GrigDesk', 'README.md', 'bin/tracker', 'bin/deepseek', 'bin/grigdesk-ctl',
  'bin/grigdesk-relay', 'bin/grigdesk-server', 'bin/lib/runtime-env.sh',
].sort();

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Только явно опубликованный комплект копируется настоящим tar в одноразовый путь с пробелами.
 * Без env suite помечена NOT RUN и никогда не подменяет приёмку injected-заглушками.
 */
async function bundleFixture(t: TestContext) {
  assert.ok(bundleDirectory && path.isAbsolute(bundleDirectory));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-acceptance-'));
  const archive = path.join(path.dirname(bundleDirectory), 'release.tar.gz');
  const checksums = path.join(path.dirname(bundleDirectory), 'release.tar.gz.sha256');
  const unpack = path.join(root, 'unpack with spaces');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(unpack);

  const listing = await execute('tar', ['-tzf', archive]);

  for (const entry of listing.stdout.trim().split('\n')) {
    assert.ok(entry.startsWith('release/'), entry);
    assert.ok(!entry.split('/').includes('..'), entry);
  }

  await execute('tar', ['-xzf', archive, '-C', unpack]);

  return {
    root,
    release: path.join(unpack, 'release'),
    archive,
    checksums,
  };
}

/**
 * Реальный каталог проверяется независимо от описи, чтобы забытый файл не скрыла её omission.
 * Symlink не является переносимым payload и не проходит вместо обычного файла.
 */
async function inventory(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];

  for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);

    assert.ok(!item.isSymbolicLink(), relative);

    if (item.isDirectory()) {
      files.push(...await inventory(root, relative));
    } else {
      files.push(relative);
    }
  }

  return files.sort();
}

/**
 * Бандл headless driver включает production-координатор, runtimeConfig и supervisor до namespace.
 * Node извлекается в отдельную Control D, поэтому проверяемая cold D не прогревается bootstrap-ом.
 */
async function isolatedFixture(t: TestContext) {
  const box = await bundleFixture(t);
  const suite = path.join(box.root, 'suite');
  const data = path.join(box.root, 'D');
  const control = path.join(box.root, 'Control');

  for (const directory of [suite, data, control]) {
    await fs.mkdir(directory);
  }

  const { build } = await import('../../server/node_modules/esbuild/lib/main.js');

  await build({
    entryPoints: [new URL('./helpers/portableBundleDriver.mjs', import.meta.url).pathname],
    outfile: path.join(suite, 'driver.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
    banner: {
      js: 'import { createRequire } from "node:module"; '
        + 'const require = createRequire(import.meta.url); '
        + 'globalThis.__grigdeskHelperEntry = "portable-acceptance";',
    },
  });

  const hostNode = '#!/bin/sh\necho called >> /D/host-node-attempts\nexit 97\n';

  await fs.writeFile(path.join(suite, 'host-node'), hostNode, {
    mode: 0o755,
  });
  await fs.writeFile(path.join(suite, 'bootstrap.sh'), [
    '#!/bin/sh',
    'set -eu',
    'GRIGDESK_HOME=/Control "$1" --prepare --json > /Control/prepared.json',
    'runtime_node=$(python3 -I -S -c '
      + '\'import json; print(json.load(open("/Control/prepared.json"))["node"])\')',
    'token=$(python3 -I -S -c '
      + '\'import json; print(json.load(open("/Control/prepared.json"))["preparationToken"])\')',
    'package=$(python3 -I -S -c '
      + '\'import json; print(json.load(open("/Control/prepared.json"))["packageId"])\')',
    'set +e',
    '"$runtime_node" /suite/driver.mjs "$2"',
    'result=$?',
    'GRIGDESK_HOME=/Control "$1" --release-preparation "$token" --package-id "$package" --json >/dev/null',
    'exit "$result"',
  ].join('\n'), { mode: 0o755 });

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  await fs.writeFile(path.join(suite, 'passwd'), `fixture:x:${uid}:${gid}:fixture:/D/home:/bin/sh\n`);
  await fs.writeFile(path.join(suite, 'group'), `fixture:x:${gid}:\n`);
  await fs.writeFile(path.join(suite, 'nsswitch.conf'), 'passwd: files\ngroup: files\nhosts: files\n');
  await fs.writeFile(path.join(suite, 'hosts'), '127.0.0.1 localhost\n::1 localhost\n');

  return {
    ...box,
    suite,
    data,
    control,
  };
}

/**
 * В namespace нет checkout и HOME владельца, installation смонтирована read-only.
 * Оба стандартных Node и PATH Node закрыты stub97; API и дочерний ELF проверяет driver.
 */
async function runIsolated(
  box: Awaited<ReturnType<typeof isolatedFixture>>,
  mode: 'cold' | 'existing' | 'relocate',
  mount = '/Bundle with spaces',
) {
  const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc',
    '--unshare-uts', '--die-with-parent', '--clearenv', '--ro-bind', '/usr', '/usr'];

  for (const directory of ['/bin', '/sbin', '/lib', '/lib64']) {
    if ((await fs.lstat(directory)).isSymbolicLink()) {
      args.push('--symlink', await fs.readlink(directory), directory);
    } else {
      args.push('--ro-bind', directory, directory);
    }
  }

  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--dir', '/etc/ssl', '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs',
    '--ro-bind', '/etc/ssl/openssl.cnf', '/etc/ssl/openssl.cnf',
    '--ro-bind', box.release, mount, '--ro-bind', box.release, '/A',
    '--ro-bind', box.suite, '/suite', '--bind', box.data, '/D', '--bind', box.control, '/Control',
    '--dir', '/host-bin', '--ro-bind', path.join(box.suite, 'host-node'), '/host-bin/node');

  for (const file of ['passwd', 'group', 'nsswitch.conf', 'hosts']) {
    args.push('--ro-bind', path.join(box.suite, file), `/etc/${file}`);
  }

  const nodes = new Set<string>();

  for (const node of ['/usr/bin/node', '/usr/bin/nodejs', '/usr/local/bin/node']) {
    const physical = await fs.realpath(node).catch(() => '');

    if (physical.startsWith('/usr/')) {
      nodes.add(physical);
    }
  }

  for (const node of nodes) {
    args.push('--ro-bind', path.join(box.suite, 'host-node'), node);
  }

  const env = {
    PATH: '/host-bin:/usr/bin:/bin',
    HOME: '/D/home',
    XDG_DATA_HOME: '/D/xdg',
    XDG_CONFIG_HOME: '/D/config',
    GRIGDESK_HOME: '/D',
    NODE_ENV: 'production',
    FACTORY_FORBID_LIVE: '1',
    FACTORY_CONTROL_ROOT: '/D/control',
    FACTORY_STATE_DIR: '/D/provider-state',
  };

  for (const [key, value] of Object.entries(env)) {
    args.push('--setenv', key, value);
  }

  const settings = JSON.stringify({
    mode,
    mount,
    checkout: path.resolve(import.meta.dirname, '../..'),
    ownerHome: os.homedir(),
  });
  const result = await execute('/usr/bin/bwrap', [...args, '--chdir', '/D', '--',
    '/bin/sh', '/suite/bootstrap.sh', `${mount}/bin/grigdesk-server`, settings], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 480000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const report = result.stdout.split('\n').find((line) => line.startsWith('PORTABLE_REPORT '));

  assert.ok(report, result.stdout + result.stderr);

  return JSON.parse(report.slice('PORTABLE_REPORT '.length));
}

test('PB-REAL-01: настоящий архив, точный состав, SHA, права и версия 0.1.0', publishedOnly, async (t) => {
  const box = await bundleFixture(t);
  const manifest = JSON.parse(await fs.readFile(path.join(box.release, 'bin/bundle.json'), 'utf8'));

  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.kind, 'portable');
  assert.deepEqual(await inventory(box.release), [...expectedPayload, 'bin/bundle.json'].sort());
  assert.deepEqual(manifest.files.map((entry: { path: string }) => entry.path).sort(), expectedPayload);

  for (const entry of manifest.files) {
    const file = path.join(box.release, entry.path);
    const bytes = await fs.readFile(file);
    const mode = (await fs.stat(file)).mode & 0o777;

    assert.equal(sha256(bytes), entry.sha256, entry.path);
    assert.equal(bytes.length, entry.size, entry.path);
    assert.equal(mode, /\.md$|\.sh$/u.test(entry.path) ? 0o644 : 0o755, entry.path);
  }

  const checksums = await fs.readFile(box.checksums, 'utf8');
  const checksumFiles: Array<[string, string]> = [
    ['release.tar.gz', box.archive],
    ['release/bin/bundle.json', path.join(box.release, 'bin/bundle.json')],
  ];

  for (const [relative, file] of checksumFiles) {
    assert.ok(checksums.split('\n').includes(`${sha256(await fs.readFile(file))}  ${relative}`));
  }
});

test('PB-REAL-02: cold HOME без checkout/host Node, v4, настоящий ELF, API и штатный stop',
  publishedOnly, async (t) => {
    const box = await isolatedFixture(t);
    const result = await runIsolated(box, 'cold');

    assert.equal(result.descriptor.binary, '/Bundle with spaces/bin/grigdesk-server');
    assert.equal(result.api, 'grigdesk');
    assert.equal(result.ownStopped, true);
    assert.deepEqual(result.binaries, ['/Bundle with spaces/bin/grigdesk-server']);
  });

test('PB-REAL-03: прежний настоящий сервер остаётся, сосед выбирается через shell-select',
  publishedOnly, async (t) => {
    const box = await isolatedFixture(t);
    const result = await runIsolated(box, 'existing');

    assert.deepEqual(result.binaries, ['/A/bin/grigdesk-server', '/Bundle with spaces/bin/grigdesk-server']);
    assert.equal(result.ownStopped, true);
    assert.equal(result.api, 'grigdesk');
  });

test('PB-REAL-04: перенос закрытого комплекта сохраняет D и меняет ELF с одним сообщением',
  publishedOnly, async (t) => {
    const box = await isolatedFixture(t);
    const first = await runIsolated(box, 'cold', '/Old');
    const moved = path.join(box.root, 'moved release with spaces');

    assert.equal(first.ownStopped, true);
    await fs.rename(box.release, moved);
    box.release = moved;

    const second = await runIsolated(box, 'relocate', '/New');

    assert.equal(second.descriptor.home, first.descriptor.home);
    assert.equal(second.selected, first.selected);
    assert.equal(second.notices, 1);
    assert.equal(second.descriptor.binary, '/New/bin/grigdesk-server');
    assert.equal(second.ownStopped, true);
  });
