import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { currentExternalCliProcess } from '../providerInstall/externalCliProcess.ts';
import { acquireCliLease } from '../providerInstall/leases.ts';
import { qwenConfig, type QwenSnapshot } from './settings.ts';

export interface QwenMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
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
 * Пустая файловая система даёт процессу одну writable папку и свой durable home.
 * Ambient settings, hooks и .env проекта перекрываются server-owned снимком до запуска CLI.
 */
export async function startQwenSandbox(configValue: unknown, snapshot: QwenSnapshot, options: {
  cwd: string;
  home: string;
  authType: string;
  mode: string;
  readonlyRoots?: string[];
  mcpServers?: QwenMcpServer[];
}) {
  const config = qwenConfig(configValue);
  const context = currentExternalCliProcess();
  const bwrap = process.env.GRIGDESK_QWEN_BWRAP_BIN || '/usr/bin/bwrap';

  if (process.platform !== 'linux') {
    throw new Error('Qwen: требуется Linux и песочница bwrap');
  }

  try {
    await fs.access(bwrap, constants.X_OK);
  } catch {
    throw new Error('Qwen: недоступна обязательная песочница bwrap');
  }

  if (!context) {
    throw new Error('Qwen: не подготовлена выбранная копия CLI');
  }

  const lease = await acquireCliLease({
    directory: context.leaseDirectory,
    providerId: context.providerId,
    resourceKey: context.resourceKey,
    mode: 'reader',
  });
  let child: ChildProcess | undefined;
  const placeholders: Array<{
    file: string;
    ino: number;
    directory: boolean;
  }> = [];
  let privateDir: string | undefined;

  // Пустые точки монтирования создаются эксклюзивно и удаляются только по своему inode.
  // Изменённый человеком или наполненный каталог никогда не удаляется рекурсивно.
  const cleanup = async () => {
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
    await fs.mkdir(options.home, { recursive: true, mode: 0o700 });
    privateDir = await fs.mkdtemp(path.join(options.home, 'turn-'));

    const qwenHome = path.join(options.home, '.qwen');
    const safeSettings = path.join(privateDir, 'settings.json');
    const empty = path.join(privateDir, 'empty');
    const temp = path.join(privateDir, 'tmp');

    await fs.mkdir(qwenHome, { recursive: true, mode: 0o700 });
    await fs.mkdir(empty);
    await fs.mkdir(temp);
    await fs.writeFile(safeSettings, JSON.stringify(snapshot.settings), { mode: 0o400 });
    await fs.writeFile(path.join(privateDir, 'empty.json'), '{}', { mode: 0o400 });
    await fs.writeFile(path.join(qwenHome, 'settings.json'), JSON.stringify(snapshot.settings), {
      mode: 0o600,
    });

    for (const [name, directory] of [['.qwen', true], ['.env', false]] as const) {
      const file = path.join(options.cwd, name);

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

    const bin = await fs.realpath(context.executable);
    const node = await fs.realpath(process.execPath);
    const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc',
      '--unshare-uts', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
    const mounted = new Set<string>();
    // Повторный mount того же назначения не расширяет область записи.
    // Отсутствующие необязательные системные пути пропускаются до запуска.
    const bind = async (source: string, target = source, write = false) => {
      if (mounted.has(target)) {
        return;
      }

      try {
        await fs.access(source);
      } catch {
        return;
      }

      args.push(write ? '--bind' : '--ro-bind', source, target);
      mounted.add(target);
    };

    for (const file of ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl', '/etc/resolv.conf',
      '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']) {
      await bind(file);
    }

    await bind(path.dirname(node));
    await bind(await packageRoot(bin));

    for (const root of options.readonlyRoots || []) {
      await bind(root);
    }

    await bind(options.cwd, options.cwd, true);
    await bind(options.home, options.home, true);
    await bind(privateDir);
    await bind(empty, path.join(options.cwd, '.qwen'));
    await bind(path.join(privateDir, 'empty.json'), path.join(options.cwd, '.env'));

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
    await bind(temp, '/tmp/qwen-tmp', true);
    args.push('--remount-ro', '/', '--remount-ro', '/tmp');

    const env: NodeJS.ProcessEnv = {
      PATH: `${path.dirname(node)}:/usr/bin:/bin`,
      HOME: options.home,
      TMPDIR: '/tmp/qwen-tmp',
      QWEN_HOME: qwenHome,
      QWEN_CODE_SYSTEM_SETTINGS_PATH: safeSettings,
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(privateDir, 'empty.json'),
      CI: '1',
      NO_COLOR: '1',
      LANG: 'C.UTF-8',
    };

    for (const key of snapshot.envKeys) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }

    const nonce = randomUUID();

    env.QWEN_CODE_PRIVATE_ACP_CAPABILITY = nonce;
    env.QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD = 'required-v1';
    env.QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER = 'attached-v1';
    args.push('--chdir', options.cwd, '--', node, bin, '--acp', '--auth-type', options.authType,
      '--approval-mode', options.mode);
    child = spawn(bwrap, args, {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const owned = child;
    const closed = new Promise<void>((resolve) => {
      owned.once('close', () => resolve());
      owned.once('error', () => resolve());
    });

    await new Promise<void>((resolve, reject) => {
      owned.once('spawn', resolve);
      owned.once('error', reject);
    });
    await lease.attachSession(owned.pid!);
    await lease.attachChild(owned.pid!);

    return {
      child: owned,
      nonce,
      /**
       * Завершается только собственная группа; reader снимается после reaping.
       * Уборка точек монтирования не затрагивает чужие файлы рабочей папки.
       */
      async close() {
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

        await closed;
        clearTimeout(timer);
        await lease.release();
        await cleanup();
      },
    };
  } catch (error) {
    child?.kill('SIGKILL');
    await lease.release();
    await cleanup();

    throw error;
  }
}
