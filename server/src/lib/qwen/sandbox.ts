import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dataHome } from '../../../../shared/runtime/dataHome.ts';
import { acquireCliLease } from '../providerInstall/leases.ts';
import { redactRunnerError } from '../factoryProviderRunner.ts';
import { startQwenHostScope } from './host.ts';
import { qwenPreviewSettings } from './previewModels.ts';
import { openQwenPreviewGateway } from './previewGateway.ts';
import { verifyQwenPreviewBinary } from './previewRelease.ts';
import { qwenPreviewNativeTools } from './previewPolicy.ts';
import { qwenBin, qwenConfig, type QwenSnapshot } from './settings.ts';
import { QWEN_SKILLS_MOUNT } from './skills.ts';

export interface QwenMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface QwenOwnedProcess {
  child: ChildProcess;
  close: () => Promise<void>;
}

export interface QwenLaunchOptions {
  cwd: string;
  extraDirs?: readonly string[];
  home: string;
  authType: string;
  mode: string;
  nativeModelId?: string;
  readonlyRoots?: string[];
  skillDirectories?: string[];
  mcpServers?: QwenMcpServer[];
  hostAccess?: boolean;
  onOwnedProcess?: (resource: QwenOwnedProcess) => void;
}

/**
 * Монтируется только пакет выбранного CLI, а не родительский пользовательский каталог.
 * Одиночный исполняемый скрипт без package.json получает собственный read-only файл.
 */
async function packageRoot(file: string): Promise<string> {
  let directory = path.dirname(file);

  while (directory !== path.dirname(directory)) {
    try {
      await fs.access(path.join(directory, 'package.json'));

      return directory;
    } catch {
      directory = path.dirname(directory);
    }
  }

  return file;
}

/**
 * Профиль и ELF защищены отдельными mounts в обоих режимах доступа.
 * Песочница выдаёт выбранные корни, а «Хост» привязывает весь процесс к user scope.
 */
export async function startQwenSandbox(
  configValue: unknown, snapshot: QwenSnapshot, options: QwenLaunchOptions,
) {
  const host = options.hostAccess === true;
  const bwrap = process.env.GRIGDESK_QWEN_BWRAP_BIN || '/usr/bin/bwrap';
  const workspaceRoots = [options.cwd, ...options.extraDirs || []];

  if (process.platform !== 'linux') {
    throw Object.assign(new Error('Qwen: требуется Linux и песочница bwrap'), {
      code: 'platform_capability_unsupported',
    });
  }

  try {
    await fs.access(bwrap, constants.X_OK);
  } catch {
    throw new Error('Qwen: недоступна обязательная песочница bwrap');
  }

  const appConfig = qwenConfig(configValue);
  const runtimeHome = appConfig.dataHome || dataHome({ env: process.env, home: os.homedir() });
  let lease: Awaited<ReturnType<typeof acquireCliLease>> | undefined;
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let hostScope: Awaited<ReturnType<typeof startQwenHostScope>> | undefined;
  let ownershipReleased = false;
  let binary: Awaited<ReturnType<typeof verifyQwenPreviewBinary>> | undefined;
  let gateway: Awaited<ReturnType<typeof openQwenPreviewGateway>> | undefined;
  let stderr = '';
  const placeholders: Array<{
    file: string;
    ino: number;
    directory: boolean;
  }> = [];
  let privateDir: string | undefined;

  // Пустые точки монтирования создаются эксклюзивно и удаляются только по своему inode.
  // Изменённый человеком или наполненный каталог никогда не удаляется рекурсивно.
  const cleanup = async () => {
    await gateway?.close();

    for (const entry of placeholders) {
      const stat = await fs.lstat(entry.file).catch(() => null);

      if (stat?.ino !== entry.ino || (!entry.directory && stat.size !== 0)) {
        continue;
      }

      if (entry.directory) {
        await fs.rmdir(entry.file).catch(() => undefined);
      } else {
        await fs.unlink(entry.file);
      }
    }

    if (privateDir) {
      await fs.rm(privateDir, { recursive: true, force: true });
    }
  };

  try {
    binary = await verifyQwenPreviewBinary(qwenBin(appConfig));
    lease = await acquireCliLease({
      directory: path.join(runtimeHome, 'provider-cli-leases'),
      providerId: 'qwen',
      resourceKey: createHash('sha256').update(binary.physical).digest('hex'),
      mode: 'reader',
    });

    const reader = lease;

    await fs.mkdir(options.home, { recursive: true, mode: 0o700 });
    privateDir = await fs.mkdtemp(path.join(options.home, 'turn-'));

    const config = path.join(privateDir, 'config');
    const empty = path.join(privateDir, 'empty');
    const temp = path.join(privateDir, 'tmp');
    const projects = path.join(options.home, 'projects');
    const configTarget = host ? config : '/tmp/qwen-config';
    const tempTarget = host ? temp : '/tmp/qwen-tmp';
    const binaryTarget = host ? path.join(config, 'qwen') : '/qwen';
    const directories = [...options.extraDirs || [], ...options.readonlyRoots || []];

    await fs.mkdir(config);
    await fs.mkdir(path.join(config, 'skills'));
    await fs.mkdir(projects, { recursive: true, mode: 0o700 });
    await fs.mkdir(empty);
    await fs.mkdir(temp);

    if (host) {
      await fs.writeFile(binaryTarget, '', { mode: 0o400 });
    }

    const requireWorkMcp = options.mcpServers?.some(({ name }) => name === 'grigdesk-work');

    gateway = await openQwenPreviewGateway(snapshot, requireWorkMcp);

    const settings = qwenPreviewSettings(snapshot, directories, gateway, options.nativeModelId);
    const authority = { rules: [{ subject: { kind: 'tool', toolName: '*' }, behavior: 'ask' }] };

    await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify(settings), { mode: 0o400 });
    await fs.writeFile(path.join(config, 'managed-settings.json'), JSON.stringify(authority), {
      mode: 0o400,
    });
    await fs.writeFile(path.join(privateDir, 'empty.json'), '{}', { mode: 0o400 });

    const mutableDirs = ['projects', 'logs', 'memory', 'shell-snapshots', 'host-actions', 'todos', 'tasks'];

    for (const directory of mutableDirs) {
      await fs.mkdir(path.join(config, directory));
      await fs.mkdir(path.join(temp, directory));
    }

    for (const root of workspaceRoots) {
      for (const [name, directory] of [['.qwen', true], ['.env', false]] as const) {
        const file = path.join(root, name);

        try {
          if (directory) {
            await fs.mkdir(file, { mode: 0o700 });
          } else {
            await fs.writeFile(file, '', { mode: 0o600, flag: 'wx' });
          }

          placeholders.push({
            file,
            directory,
            ino: (await fs.lstat(file)).ino,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
        }
      }
    }

    const node = await fs.realpath(process.execPath);
    const args = ['--die-with-parent', '--new-session'];

    if (host) {
      // У полного bind / устройства получают nodev. Bun требует /dev/urandom при старте.
      args.push('--bind', '/', '/', '--dev', '/dev');
    } else {
      args.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--proc', '/proc',
        '--dev', '/dev', '--tmpfs', '/tmp');
    }

    const mounted = new Map<string, boolean>();
    // Повторный mount может только сузить доступ: read-only сильнее прежнего writable.
    // Отсутствующие необязательные системные пути пропускаются до запуска.
    const bind = async (source: string, target = source, write = false) => {
      if (mounted.has(target) && (write || mounted.get(target) === false)) {
        return;
      }

      try {
        await fs.access(source);
      } catch {
        return;
      }

      args.push(write ? '--bind' : '--ro-bind', source, target);
      mounted.set(target, write);
    };

    // Системные alternatives и кэш загрузчика нужны зависимостям ffmpeg/ffprobe.
    // Монтируются публичные системные данные, а не весь /etc с настройками хоста.
    if (!host) {
      for (const file of ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl', '/etc/resolv.conf',
        '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group',
        '/etc/alternatives', '/etc/ld.so.cache']) {
        await bind(file);
      }

      await bind(path.dirname(node));

      for (const root of [...workspaceRoots].sort((left, right) => left.length - right.length)) {
        await bind(root, root, true);
      }
    }

    // Read-only ресурсы накладываются после writable workspace: общий каталог навыков
    // не становится изменяемым, даже когда выбранная рабочая папка содержит его родителя.
    for (const root of options.readonlyRoots || []) {
      await bind(root);
    }
    // Bind mount следует за ссылкой назначения: её цель тоже должна существовать
    // внутри пустой ФС. Подготавливаем пустую цель, не монтируя секретный исходный файл.
    for (const root of workspaceRoots) {
      for (const [name, source] of [
        ['.qwen', empty],
        ['.env', path.join(privateDir, 'empty.json')],
      ] as const) {
        const file = path.join(root, name);
        const entry = await fs.lstat(file);

        if (entry.isSymbolicLink()) {
          const target = path.resolve(path.dirname(file), await fs.readlink(file));
          const protectedRoots = [...workspaceRoots, options.home, privateDir, path.dirname(node),
            configTarget, tempTarget, '/qwen', '/usr', '/bin', '/lib', '/lib64', '/proc', '/dev'];

          if (target === path.parse(target).root
            || protectedRoots.some((directory) => directory === target
              || directory.startsWith(`${target}/`))) {
            throw new Error(`Qwen: ссылка ${name} перекрывает рабочую папку или служебный каталог.`);
          }

          if (workspaceRoots.some((directory) => target.startsWith(`${directory}/`))
            && !await fs.lstat(target).catch(() => null)) {
            throw new Error(`Qwen: цель ссылки ${name} отсутствует внутри рабочей папки.`);
          }

          args.push('--ro-bind', source, target);
        } else {
          args.push('--ro-bind', source, file);
        }
      }
    }

    // Сервер передаёт только явно выданные MCP. Скрипты и UDS доступны на чтение;
    // остальные папки данных и канал управления Factory в песочницу не попадают.
    for (const server of options.mcpServers || []) {
      await bind(path.dirname(await fs.realpath(server.command)));

      for (let index = 0; index < server.args.length; index += 1) {
        const arg = server.args[index]!;

        if (path.isAbsolute(arg)) {
          await bind(arg.endsWith('.sock') ? path.dirname(arg) : await packageRoot(arg));
        }
      }
    }

    // Родители bind mounts тоже закрыты от записи: иначе можно создать ложный
    // соседний файл в пустом /tmp. Временные файлы CLI получают отдельный writable mount.
    if (!host) {
      await bind(temp, tempTarget, true);
    }

    await bind(config, configTarget);

    const [skillDirectory] = options.skillDirectories ?? [];

    if (skillDirectory) {
      await bind(skillDirectory, QWEN_SKILLS_MOUNT);
    }

    for (const directory of mutableDirs) {
      const source = directory === 'projects' ? projects : path.join(temp, directory);

      await bind(source, path.join(configTarget, directory), true);
    }

    // bwrap получает уже проверенный inode через дополнительный дескриптор.
    // Повторная подстановка пути после расчёта SHA не меняет запущенную программу.
    args.push('--ro-bind', '/proc/self/fd/3', binaryTarget);

    if (!host) {
      args.push('--remount-ro', '/', '--remount-ro', '/tmp');
    }

    const env: NodeJS.ProcessEnv = {
      PATH: `${path.dirname(node)}:/usr/bin:/bin`,
      HOME: tempTarget,
      TMPDIR: tempTarget,
      CI: '1',
      NO_COLOR: '1',
      LANG: 'C.UTF-8',
      QWEN_EXPOSE_TOKEN_USAGE: '1',
      ...(requireWorkMcp ? { QWEN_MCP_INIT_BUDGET_MS: '15000' } : {}),
    };

    args.push('--chdir', options.cwd, '--', binaryTarget, '--acp', '--config-dir', configTarget,
      '--setting-sources', 'user', '--permission-mode', 'default', '--strict-mcp-config',
      '--disable-builtin-skills', '--tools', ...qwenPreviewNativeTools);

    if (host) {
      hostScope = await startQwenHostScope(bwrap, args, {
        cwd: options.cwd,
        env: {
          ...env,
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        },
        executableFd: binary.descriptor.fd,
      });
    }

    child = hostScope?.child ?? spawn(bwrap, args, {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', binary.descriptor.fd],
    });

    const owned = child;
    const exited = new Promise<void>((resolve) => {
      owned.once('close', () => resolve());
      owned.once('error', () => resolve());
    });

    closed = exited;
    owned.stderr?.on('data', (part: Buffer) => {
      stderr = (stderr + part.toString()).slice(-8192);
    });

    let closing: Promise<void> | undefined;

    /**
     * В режиме «Хост» закрытие подтверждает systemd, в песочнице — собственный child.
     * Файлы и аренда остаются до завершения всех выданных процессов.
     */
    async function terminate() {
      if (hostScope) {
        await hostScope.close();
      } else {
        try {
          process.kill(-owned.pid!, 'SIGTERM');
        } catch {
          // Своя группа могла уже выйти после ошибки CLI.
        }

        const timer = setTimeout(() => {
          try {
            process.kill(-owned.pid!, 'SIGKILL');
          } catch {
            // TERM уже завершил свою группу.
          }
        }, 500);

        await exited;
        clearTimeout(timer);
      }

      await reader.release();
      await cleanup();
    }

    const resource = {
      child: owned,
      stderr: () => stderr || hostScope?.stderr() || '',
      workMcpUnavailable: gateway.workMcpUnavailable,
      /**
       * Завершение своей OS-группы подтверждается до снятия reader.
       * Ошибка закрытия сохраняет владельцу возможность повторить операцию.
       */
      close(): Promise<void> {
        closing ??= terminate().catch((error) => {
          closing = undefined;

          throw error;
        });

        return closing;
      },
    };

    options.onOwnedProcess?.(resource);
    ownershipReleased = Boolean(options.onOwnedProcess);

    await (hostScope?.ready ?? new Promise<void>((resolve, reject) => {
      owned.once('spawn', resolve);
      owned.once('error', reject);
    }));
    await binary.descriptor.close();
    binary = undefined;
    await reader.attachSession(owned.pid!);
    await reader.attachChild(owned.pid!);

    return resource;
  } catch (error) {
    await binary?.descriptor.close();

    if (!ownershipReleased) {
      if (hostScope) {
        await hostScope.close();
      } else {
        child?.kill('SIGKILL');
        await closed;
      }

      await lease?.release();
      await cleanup();
    }

    const reason = stderr ? `Qwen: не удалось запустить песочницу. ${stderr.trim()}` : error;
    const message = redactRunnerError(reason, snapshot.envKeys.map((key) => process.env[key]));

    throw Object.assign(new Error(message), {
      code: (error as NodeJS.ErrnoException).code,
    });
  }
}
