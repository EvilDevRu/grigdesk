import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readGigaCodeCredentialSnapshot } from './auth.ts';
import { GIGACODE_PACKAGED_UNSUPPORTED } from './contract.ts';
import type { GigaCodeConfig } from './contract.ts';
import { resolveGigaCodeInstallation } from './discovery.ts';
import { readProcessIdentity } from '../packageInstall/workerIdentity.ts';

export interface GigaCodeProfileOptions {
  config: GigaCodeConfig;
  cwd?: string;
  permissionMode?: string;
  extraDirs?: string[];
  writableRoots?: string[];
  readonlyRuntimePaths?: string[];
  blockShell?: boolean;
  autoEdit?: boolean;
}

/**
 * Типизированная ошибка содержит безопасный текст, без сырых настроек и токена.
 * Одинаковый контракт используется chat, metadata и Factory до запуска модели.
 */
export function gigaCodeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Проверяется отношение путей по компонентам, включая равенство.
 * Строковый startsWith ошибочно считал бы соседний project-copy дочерним project.
 */
export function gigaCodeRootContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

/**
 * Источники mounts разрешаются в realpath до построения argv.
 * Ссылка на чужой каталог не расширяет объявленные writable roots незаметно.
 */
async function roots(values: string[]): Promise<string[]> {
  const result: string[] = [];

  for (const value of values) {
    if (!path.isAbsolute(value)) {
      throw gigaCodeError('gigacode_invalid_roots', 'Корень должен быть абсолютным');
    }

    const resolved = await fs.realpath(value);

    if (resolved !== path.resolve(value) || !(await fs.stat(resolved)).isDirectory()) {
      throw gigaCodeError('gigacode_invalid_roots', 'Корень не должен быть ссылкой или файлом');
    }

    if (!result.includes(resolved)) {
      result.push(resolved);
    }
  }

  return result;
}

interface HomeOwner {
  pid: number;
  starttime: string;
}

/**
 * Читается небольшой host-owned owner без следования ссылкам и без догадок по возрасту.
 * Отсутствующая или повреждённая запись не доказывает, что каталог можно удалить.
 */
async function readHomeOwner(home: string): Promise<HomeOwner | null> {
  const handle = await fs.open(path.join(home, 'owner'), constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => null);

  if (!handle) {
    return null;
  }

  try {
    const info = await handle.stat();

    if (!info.isFile() || info.size > 1024) {
      return null;
    }

    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead !== info.size) {
      return null;
    }

    const owner = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as Partial<HomeOwner> | null;

    if (!owner || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.starttime !== 'string' || !/^\d+$/u.test(owner.starttime)) {
      return null;
    }

    return {
      pid: owner.pid,
      starttime: owner.starttime,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Общий root может содержать живые home чата и Factory разных процессов.
 * Удаляется только turn с доказанно исчезнувшим PID либо с другим временем старта PID.
 */
async function cleanupAbandonedHomes(runtimeRoot: string): Promise<void> {
  const entries = await fs.readdir(runtimeRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.name.startsWith('turn-') || !entry.isDirectory()) {
      continue;
    }

    const home = path.join(runtimeRoot, entry.name);
    const owner = await readHomeOwner(home);

    if (!owner) {
      continue;
    }

    let current;

    try {
      current = await readProcessIdentity(owner.pid);
    } catch {
      // Ошибка чтения /proc не доказывает смерть; чужой живой home сохраняется.
      continue;
    }

    if (current?.startTime !== owner.starttime) {
      await fs.rm(home, { recursive: true, force: true });
    }
  }
}

/**
 * Host-owned namespace делает исходники readonly независимо от native approval mode.
 * Каждый профиль имеет собственный home; исходные настройки и credential не меняются.
 */
export async function buildGigaCodeProfile(options: GigaCodeProfileOptions) {
  const mode = options.permissionMode || 'default';

  if (!['default', 'auto', 'read-only', 'state-only'].includes(mode)) {
    throw gigaCodeError('gigacode_invalid_mode', 'Неизвестный режим прав GigaCode');
  }

  // Ход и metadata в комплекте не стартуют: process.execPath там — сервер, а не node.
  if (options.config.gigacodePackaged) {
    throw gigaCodeError('gigacode_packaged_unsupported', GIGACODE_PACKAGED_UNSUPPORTED);
  }

  if (process.platform !== 'linux') {
    throw gigaCodeError('gigacode_sandbox_unavailable', 'Для GigaCode требуется Linux и bubblewrap');
  }

  const command = options.config.gigacodeBwrapBin || '/usr/bin/bwrap';

  await fs.access(command, constants.X_OK).catch(() => {
    throw gigaCodeError('gigacode_sandbox_unavailable', 'Bubblewrap недоступен');
  });

  const installation = await resolveGigaCodeInstallation(options.config);
  const snapshot = await readGigaCodeCredentialSnapshot(options.config);

  if (!snapshot) {
    throw gigaCodeError('gigacode_auth_required', 'Сначала выполните вход в GigaCode CLI');
  }

  const runtimeRoot = path.resolve(options.config.gigacodeRuntimeHome
    || path.join(os.tmpdir(), `grigdesk-gigacode-${process.getuid?.() || 0}`));
  const nativeHome = await fs.realpath(options.config.gigacodeHome
    || path.join(os.homedir(), '.gigacode'));

  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });

  const runtimeInfo = await fs.lstat(runtimeRoot);

  if (runtimeInfo.isSymbolicLink() || (runtimeInfo.mode & 0o077) !== 0
    || await fs.realpath(runtimeRoot) !== runtimeRoot) {
    throw gigaCodeError('gigacode_unsafe_home', 'Private runtime home должен иметь права 0700 без ссылок');
  }

  const identity = await readProcessIdentity(process.pid);

  if (!identity) {
    throw gigaCodeError('gigacode_owner_unavailable', 'Не удалось определить владельца private home');
  }

  await cleanupAbandonedHomes(runtimeRoot);

  const home = await fs.mkdtemp(path.join(runtimeRoot, 'turn-'));

  try {
    const ownerFile = path.join(home, 'owner');

    // Owner появляется до первого credential; окно mkdtemp→owner не содержит токенов.
    // Незавершённое создание без owner нельзя отличить от параллельного живого запуска.
    await fs.writeFile(ownerFile, JSON.stringify({
      pid: process.pid,
      starttime: identity.startTime,
    }), {
      mode: 0o600,
      flag: 'wx',
    });

    const privateNative = path.join(home, '.gigacode');
    const empty = path.join(home, 'empty');
    const emptyFile = path.join(home, 'empty-file');
    const settingsFile = path.join(home, 'system.json');

    await fs.mkdir(privateNative, { mode: 0o700 });
    await fs.mkdir(empty, { mode: 0o700 });
    await fs.writeFile(emptyFile, '', { mode: 0o600 });
    await fs.writeFile(path.join(privateNative, '.install-dir'), installation.root, { mode: 0o600 });
    await fs.writeFile(path.join(privateNative, 'gigacode_token.json'),
      JSON.stringify(snapshot.credential), { mode: 0o600 });
    await fs.writeFile(settingsFile, JSON.stringify({
      $version: 3,
      security: { auth: { selectedType: 'gigacode' } },
      general: { chatRecording: false },
      hooksConfig: { enabled: false },
      hooks: {},
      mcpServers: {},
      privacy: { usageStatisticsEnabled: false },
    }), { mode: 0o600 });

    const cwd = options.cwd ? (await roots([options.cwd]))[0]! : path.join(home, 'workspace');

    if (!options.cwd) {
      await fs.mkdir(cwd, { mode: 0o700 });
    }

    const readable = await roots([...(options.cwd ? [cwd] : []), ...(options.extraDirs || [])]);
    const writable = await roots(options.writableRoots
      || (mode === 'default' || mode === 'auto' ? readable.slice(0, 1) : []));

    if (mode === 'read-only' && writable.length) {
      throw gigaCodeError('gigacode_invalid_roots', 'Readonly не допускает writable roots');
    }

    if (mode === 'state-only' && writable.some((root) => gigaCodeRootContains(root, cwd))) {
      throw gigaCodeError('gigacode_invalid_roots', 'state-only не допускает запись в корень кода');
    }

    for (const root of [...readable, ...writable]) {
      if ([runtimeRoot, nativeHome, installation.root]
        .some((privateRoot) => gigaCodeRootContains(root, privateRoot)
          || gigaCodeRootContains(privateRoot, root))) {
        throw gigaCodeError('gigacode_invalid_roots', 'Рабочие roots пересекаются с private runtime');
      }
    }

    const prefixArgs = [
      '--die-with-parent', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--clearenv',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
    ];

    for (const source of ['/usr', '/etc/ssl', '/etc/resolv.conf', '/etc/hosts',
      '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']) {
      if (await fs.stat(source).then(() => true, () => false)) {
        prefixArgs.push('--ro-bind', source, source);
      }
    }

    for (const [target, link] of [['usr/bin', '/bin'], ['usr/sbin', '/sbin'],
      ['usr/lib', '/lib'], ['usr/lib64', '/lib64']] as const) {
      prefixArgs.push('--symlink', target, link);
    }

    prefixArgs.push('--ro-bind', process.execPath, process.execPath,
      '--ro-bind', installation.root, installation.root,
      '--bind', home, home,
      '--ro-bind', ownerFile, ownerFile,
      '--ro-bind', settingsFile, settingsFile,
      '--ro-bind', path.join(privateNative, 'gigacode_token.json'),
      path.join(privateNative, 'gigacode_token.json'));

    for (const root of readable) {
      prefixArgs.push('--ro-bind', root, root);
    }

    for (const root of writable) {
      prefixArgs.push('--bind', root, root);
    }

    for (const root of [...new Set([...readable, ...writable])]) {
      for (const [relative, replacement] of [['.gigacode', empty], ['.env', emptyFile]] as const) {
        const target = path.join(root, relative);

        if (await fs.lstat(target).then(() => true, () => false)) {
          prefixArgs.push('--ro-bind', replacement, target);
        }
      }
    }

    for (const source of options.readonlyRuntimePaths || []) {
      prefixArgs.push('--ro-bind', source, source);
    }

    const env = {
      HOME: home,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      NO_BROWSER: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
      GIGACODE_DISABLE_AUTO_ENCRYPT: 'true',
      GIGACODE_SYSTEM_SETTINGS_PATH: settingsFile,
      GIGACODE_SYSTEM_DEFAULTS_PATH: path.join(home, 'defaults.json'),
    };

    for (const [name, value] of Object.entries(env)) {
      prefixArgs.push('--setenv', name, value);
    }

    prefixArgs.push('--chdir', cwd);

    return {
      command,
      prefixArgs,
      args: [...prefixArgs, '--', installation.bin, '--acp', '--auth-type=gigacode',
        '--internal-sandbox-command=bwrap', '--experimental-hooks=false',
        `--exclude-tools=agent,skill${options.blockShell ? ',run_shell_command,web_fetch' : ''}`,
        ...(options.autoEdit ? ['--approval-mode=auto-edit'] : []),
        ...[...new Set([...readable, ...writable])].filter((root) => root !== cwd)
          .flatMap((root) => ['--include-directories', root])],
      home,
      cwd,
      fingerprint: snapshot.fingerprint,
      secret: snapshot.credential.token,
      cleanup: () => fs.rm(home, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(home, { recursive: true, force: true });

    throw error;
  }
}
