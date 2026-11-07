import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile }
  from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import { build } from '../../../server/node_modules/esbuild/lib/main.js';

const execute = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, '../../..');

/**
 * В namespace попадают лишь alternatives системных исполняемых файлов из /usr/bin и /usr/sbin.
 * Сохраняются точные ссылки; их физические targets уже доступны через read-only /usr.
 */
async function systemAlternatives(suite: string): Promise<string> {
  const directory = path.join(suite, 'alternatives');
  const aliases = new Map<string, string>();

  await mkdir(directory);

  for (const bin of ['/usr/bin', '/usr/sbin']) {
    for (const entry of await readdir(bin, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) {
        continue;
      }

      const target = await readlink(path.join(bin, entry.name));

      if (!/^\/etc\/alternatives\/[^/]+$/u.test(target)) {
        continue;
      }

      const physical = await realpath(target).catch(() => '');

      if (physical.startsWith('/usr/')) {
        aliases.set(path.basename(target), await readlink(target));
      }
    }
  }

  for (const [name, target] of aliases) {
    await symlink(target, path.join(directory, name));
  }

  return directory;
}

export interface BinaryIsolationPaths {
  source: string;
  hostHome: string;
  data: string;
  home: string;
  control: string;
  state: string;
  profiles: string;
  project: string;
  fixtures: string;
  installation: string;
  binary: string;
  runtime: string;
  deepseek: string;
  deepseekCache: string;
  packageId: string;
  baseline?: string;
  previousBinary?: string;
}

/**
 * Бандл содержит только тестовую оркестрацию, а production загружается из R по абсолютному пути.
 * Metafile закрывает случайный импорт checkout и внешние файловые зависимости до namespace.
 */
export async function bundleIsolatedDriver(entry: string, outfile: string) {
  const result = await build({
    absWorkingDir: SOURCE,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    metafile: true,
    logLevel: 'silent',
  });
  const forbidden = Object.keys(result.metafile.inputs).filter((file) =>
    /(?:^|\/)(?:server\/(?:src|scripts)|deepseek\/src)\//u.test(file.replaceAll('\\', '/')));

  assert.deepEqual(forbidden, [], 'Driver не должен встраивать production из checkout');
  assert.equal(Object.values(result.metafile.outputs).some((output) => output.imports.some((item) =>
    item.external && (item.path.startsWith('.') || path.isAbsolute(item.path)))), false);
  await writeFile(`${outfile}.meta.json`, JSON.stringify(result.metafile, null, 2));

  return result.metafile;
}

/**
 * Стенд принимает только явно подготовленные кандидаты сервера и DeepSeek.
 * Namespace и private D не используют установленную поставку или HOME владельца.
 */
export async function isolatedBinary(t: TestContext, options: {
  candidate: string;
  deepseekBinary: string;
  installationPath?: string;
  baselineRelease?: string;
  previousCandidate?: string;
}) {
  assert.ok(options.candidate, 'Укажите явный GRIGDESK_TEST_SERVER_BINARY, скрытой сборки нет');
  assert.ok(options.deepseekBinary, 'Укажите явный GRIGDESK_TEST_DEEPSEEK_BINARY, skip запрещён');

  const candidate = await realpath(options.candidate);
  const deepseek = await realpath(options.deepseekBinary);
  const metadata = await execute(candidate, ['--runtime-info', '--json'], {
    cwd: '/',
    env: { PATH: '' },
    timeout: 10000,
    maxBuffer: 65536,
  });
  const info = JSON.parse(metadata.stdout) as { packageId: string };

  assert.match(info.packageId, /^[a-f0-9]{64}$/u);

  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-binary-isolation-'));
  const installation = path.join(root, 'I');
  const data = path.join(root, 'D');
  const suite = path.join(root, 'suite');
  const mount = options.installationPath ?? '/I';
  const paths: BinaryIsolationPaths = {
    source: SOURCE,
    hostHome: os.homedir(),
    data: '/D',
    home: '/D/home',
    control: '/D/control',
    state: '/D/provider-state',
    profiles: '/D/profiles',
    project: '/D/fixtures/project with spaces',
    fixtures: '/D/fixtures',
    installation: mount,
    binary: `${mount}/bin/grigdesk-server`,
    runtime: `/D/runtimes/server/packages/${info.packageId}`,
    deepseek: '/DeepSeek/bin/deepseek',
    deepseekCache: '/D/deepseek-cache',
    packageId: info.packageId,
  };

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(installation, 'bin'), { recursive: true });
  await mkdir(suite);

  for (const directory of ['home', 'control', 'provider-state', 'profiles', 'fixtures/project with spaces']) {
    await mkdir(path.join(data, directory), { recursive: true });
  }

  await copyFile(candidate, path.join(installation, 'bin/grigdesk-server'), constants.COPYFILE_FICLONE);

  if (options.previousCandidate) {
    await mkdir(path.join(installation, 'backups'));
    await copyFile(await realpath(options.previousCandidate),
      path.join(installation, 'backups/grigdesk-server'), constants.COPYFILE_FICLONE);
    paths.previousBinary = `${mount}/backups/grigdesk-server`;
  }

  await writeFile(path.join(suite, 'host-node'), [
    '#!/bin/sh', 'echo called >> /D/host-node-attempts', 'exit 97', '',
  ].join('\n'), { mode: 0o755 });
  await writeFile(path.join(suite, 'bootstrap.sh'), [
    '#!/bin/sh',
    '"$1" --prepare --json > /D/prepared-runtime.json || exit "$?"',
    '"$2" /suite/driver.mjs "$3"',
    'result=$?',
    'token=$("$2" /suite/release.mjs) || exit "$?"',
    '"$1" --release-preparation "$token" --package-id "$4" --json > /dev/null || exit "$?"',
    'exit "$result"', '',
  ].join('\n'), { mode: 0o755 });
  await writeFile(path.join(suite, 'release.mjs'), [
    'import { readFileSync } from "node:fs";',
    'const runtime = JSON.parse(readFileSync("/D/prepared-runtime.json", "utf8"));',
    'process.stdout.write(runtime.preparationToken);', '',
  ].join('\n'));

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  await writeFile(path.join(suite, 'passwd'), `fixture:x:${uid}:${gid}:fixture:/D/home:/bin/sh\n`);
  await writeFile(path.join(suite, 'group'), `fixture:x:${gid}:\n`);
  await writeFile(path.join(suite, 'nsswitch.conf'), 'passwd: files\ngroup: files\nhosts: files\n');
  await writeFile(path.join(suite, 'hosts'), '127.0.0.1 localhost\n::1 localhost\n');

  const alternatives = await systemAlternatives(suite);

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
    '--ro-bind', alternatives, '/etc/alternatives',
    '--ro-bind', installation, mount, '--bind', data, '/D', '--ro-bind', suite, '/suite',
    '--dir', '/DeepSeek/bin', '--ro-bind', deepseek, paths.deepseek,
    '--dir', '/host-bin', '--ro-bind', path.join(suite, 'host-node'), '/host-bin/node');

  if (options.baselineRelease) {
    paths.baseline = '/Baseline';
    base.push('--ro-bind', await realpath(options.baselineRelease), paths.baseline);
  }

  for (const file of ['passwd', 'group', 'nsswitch.conf', 'hosts']) {
    base.push('--ro-bind', path.join(suite, file), `/etc/${file}`);
  }

  const systemNodes = new Set<string>();

  for (const node of ['/usr/bin/node', '/usr/bin/nodejs', '/usr/local/bin/node']) {
    const canonical = await realpath(node).catch(() => '');

    if (canonical.startsWith('/usr/')) {
      systemNodes.add(canonical);
    }
  }

  for (const node of systemNodes) {
    base.push('--ro-bind', path.join(suite, 'host-node'), node);
  }

  const env = {
    PATH: '/host-bin:/usr/bin:/bin',
    HOME: paths.home,
    LANG: 'C.UTF-8',
    GRIGDESK_HOME: paths.data,
    NODE_ENV: 'production',
    FACTORY_FORBID_LIVE: '1',
    FACTORY_CONTROL_ROOT: paths.control,
    FACTORY_STATE_DIR: paths.state,
    FACTORY_PROFILES_DIR: paths.profiles,
  };

  for (const [key, value] of Object.entries(env)) {
    base.push('--setenv', key, value);
  }

  base.push('--chdir', '/D');

  return {
    root,
    data,
    installation,
    suite,
    paths,
    info,
    /**
     * Сначала ELF подготавливает R, затем только его ordinary Node исполняет тестовый бандл.
     * Shell сохраняет preparation owner до release; завершение namespace убирает своих детей.
     */
    async run<T = Record<string, any>>(entry: string, options: {
      timeoutMs?: number;
      onProgress?: (message: string) => void;
    } = {}): Promise<T> {
      await bundleIsolatedDriver(entry, path.join(suite, 'driver.mjs'));

      const running = execute('/usr/bin/bwrap', [...base, '--', '/bin/sh', '/suite/bootstrap.sh',
        paths.binary, `${paths.runtime}/runtime/node/bin/node`, JSON.stringify(paths), paths.packageId], {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin' },
        timeout: options.timeoutMs ?? 240000,
        maxBuffer: 8 * 1024 * 1024,
      });

      running.child.stderr?.on('data', (chunk) => options.onProgress?.(String(chunk)));

      const result = await running;
      const line = result.stdout.split('\n').findLast((line) => line.startsWith('BINARY_REPORT '));

      assert.ok(line, `Driver не вернул BINARY_REPORT\n${result.stdout}\n${result.stderr}`);
      await writeFile(path.join(suite, 'driver.stdout'), result.stdout);
      await writeFile(path.join(suite, 'driver.stderr'), result.stderr);

      return JSON.parse(line.slice('BINARY_REPORT '.length)) as T;
    },
  };
}
