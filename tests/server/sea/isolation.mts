import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, writeFile }
  from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import { build } from '../../../server/node_modules/esbuild/lib/main.js';

const execute = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, '../../..');

export interface IsolationReport {
  [key: string]: unknown;
}

/**
 * Создаёт копию настоящего архива, отдельные D/suite и приватные namespaces.
 * В namespace нет HOME/source хоста, R смонтирован read-only, обычный Node — exit97.
 */
export async function isolatedRelease(t: TestContext, options: {
  mountPath?: string;
  writable?: boolean;
} = {}) {
  const release = process.env.GRIGDESK_SERVER_RELEASE_DIR;

  assert.ok(release, 'Укажите --release-dir: изоляция без готового архива не является skip');

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-isolation-'));
  const unpack = path.join(temporary, 'unpack');
  const data = path.join(temporary, 'D');
  const suite = path.join(temporary, 'suite');
  const mountPath = options.mountPath ?? '/R';
  const basename = path.basename(release).replace(/-[a-f0-9]{16}$/, '');
  const archive = path.join(path.dirname(release), `${basename}.tar.xz`);

  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(unpack);
  await mkdir(path.join(data, 'home'), { recursive: true });
  await mkdir(suite);
  await copyFile(path.join(import.meta.dirname, 'fixtures/fakeClaude.mjs'),
    path.join(suite, 'fakeClaude.mjs'));
  await execute('tar', ['-xJf', archive, '-C', unpack], { timeout: 30000 });

  const entries = await readdir(unpack);

  assert.equal(entries.length, 1);

  const root = path.join(temporary, mountPath.includes(' ') ? 'relocated R with spaces' : 'R');

  await rename(path.join(unpack, entries[0]!), root);
  await writeFile(path.join(suite, 'host-node'), [
    '#!/bin/sh',
    'echo called >> /D/host-node-attempts',
    'exit 97',
  ].join('\n'), { mode: 0o755 });

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  await writeFile(path.join(suite, 'passwd'), 'root:x:0:0:fixture:/D/home:/bin/sh\n'
    + (uid === 0 ? '' : `fixture:x:${uid}:${gid}:fixture:/D/home:/bin/sh\n`));
  await writeFile(path.join(suite, 'group'), 'root:x:0:\n'
    + (gid === 0 ? '' : `fixture:x:${gid}:\n`));
  await writeFile(path.join(suite, 'nsswitch.conf'), 'passwd: files\ngroup: files\nhosts: files dns\n');
  await writeFile(path.join(suite, 'hosts'), '127.0.0.1 localhost\n::1 localhost\n');

  const base = [
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--clearenv', '--ro-bind', '/usr', '/usr',
  ];

  for (const directory of ['/bin', '/sbin', '/lib', '/lib64']) {
    const info = await lstat(directory);

    if (info.isSymbolicLink()) {
      base.push('--symlink', await readlink(directory), directory);
    } else {
      base.push('--ro-bind', directory, directory);
    }
  }

  base.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--dir', '/etc/ssl', '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs',
    '--ro-bind', '/etc/ssl/openssl.cnf', '/etc/ssl/openssl.cnf',
    options.writable ? '--bind' : '--ro-bind', root, mountPath,
    '--bind', data, '/D', '--ro-bind', suite, '/suite');
  base.push('--dir', '/host-bin', '--ro-bind', path.join(suite, 'host-node'), '/host-bin/node');

  for (const file of ['passwd', 'group', 'nsswitch.conf', 'hosts']) {
    base.push('--ro-bind', path.join(suite, file), `/etc/${file}`);
  }

  const systemNodes = new Set<string>();

  for (const candidate of ['/usr/bin/node', '/usr/bin/nodejs', '/usr/local/bin/node']) {
    const canonical = await realpath(candidate).catch(() => '');

    if (canonical.startsWith('/usr/')) {
      systemNodes.add(canonical);
    }
  }

  for (const target of systemNodes) {
    base.push('--ro-bind', path.join(suite, 'host-node'), target);
  }

  base.push('--setenv', 'PATH', '/host-bin:/usr/bin:/bin', '--setenv', 'HOME', '/D/home',
    '--setenv', 'LANG', 'C.UTF-8', '--chdir', '/D');

  return {
    root,
    data,
    mountPath,
    /**
     * Собирает только тестовый driver; исходники не монтируются и не импортируются ребёнком.
     * Код выхода bwrap/driver определяет результат, пустой либо битый JSON — отказ.
     */
    async run(phase: string): Promise<IsolationReport> {
      const bundled = await build({
        entryPoints: [path.join(import.meta.dirname, 'drivers', `${phase}.mts`)],
        outfile: path.join(suite, 'driver.mjs'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'silent',
      });

      assert.deepEqual(bundled.warnings, []);

      const result = await execute('bwrap', [...base, '--',
        `${mountPath}/runtime/node/bin/node`, '/suite/driver.mjs', mountPath, SOURCE], {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin' },
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const integrity = await execute('bwrap', [...base, '--',
        `${mountPath}/server/grigdesk-server`, '--check-runtime'], {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin' },
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });

      assert.equal(JSON.parse(integrity.stdout).ok, true, integrity.stderr);

      return JSON.parse(result.stdout) as IsolationReport;
    },
  };
}
