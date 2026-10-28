import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { StdioOptions } from 'node:child_process';

import { isDirectRun } from '../src/lib/helperEntry.ts';
import { executableIdentity } from '../src/lib/providerInstall/executableIdentity.ts';
import { acquireCliLease } from '../src/lib/providerInstall/leases.ts';
import { InstallEnvironmentError } from '../src/lib/providerInstall/npmEnvironment.ts';

/**
 * Стадийный протокол передаёт статус и события отдельными fd выше 2.
 * Хелпер обязан пропустить их в CLI, иначе factory-стадия теряет отчёт инструмента.
 */
async function inheritedStdio(): Promise<StdioOptions> {
  const fds = (await fs.readdir('/proc/self/fd'))
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number)
    .filter((fd) => fd >= 3 && fd <= 64);
  const max = Math.max(2, ...fds);

  return Array.from({ length: max + 1 }, (_, fd) =>
    fd < 3 || fds.includes(fd) ? 'inherit' : 'ignore');
}

/**
 * Helper держит reader до доказанного выхода CLI и его потомков.
 * Своя сессия предпочтительна, но factory-стадия уже является session leader:
 * тогда helper создаёт отдельную сессию для самого CLI и отслеживает её.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let expectedIdentity: string | undefined;

  if (argv[0] === '--identity') {
    expectedIdentity = argv[1];
    argv = argv.slice(2);

    if (!expectedIdentity || !/^[0-9a-f]{64}$/u.test(expectedIdentity)) {
      return 2;
    }
  }

  const [directoryFlag, directory, providerFlag, providerId, resourceFlag, resourceKey,
    separator, command, ...args] = argv;

  if (directoryFlag !== '--lease-dir' || !directory || !path.isAbsolute(directory)
    || providerFlag !== '--provider' || !providerId || resourceFlag !== '--resource' || !resourceKey
    || separator !== '--' || !command || !path.isAbsolute(command)) {
    return 2;
  }

  const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
  const sessionId = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u)[3]);
  const lease = await acquireCliLease({
    directory,
    providerId,
    resourceKey,
    mode: 'reader',
    sessionId: sessionId === process.pid ? sessionId : undefined,
  });

  if (expectedIdentity && await executableIdentity(command).catch(() => null) !== expectedIdentity) {
    await lease.release();

    throw new InstallEnvironmentError('installation_changed', 'Выбранная программа изменилась');
  }

  // Helper-лидер уже владеет сессией: CLI остаётся в его группе и умирает вместе с ней.
  // В factory helper не лидер, поэтому CLI получает собственную сессию для учёта потомков.
  const childOwnsSession = sessionId !== process.pid;
  const child = spawn(command, args, {
    stdio: await inheritedStdio(),
    env: process.env,
    detached: childOwnsSession,
  });
  const closed = new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
  });
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Своя сессия CLI завершается группой; в общей сессии сигнал получает сам процесс.
   * Это сохраняет SIGTERM/SIGKILL-поведение timeout и не задевает чужие процессы.
   */
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) {
      return;
    }
    if (childOwnsSession) {
      try {
        process.kill(-child.pid, signal);

        return;
      } catch {
        // Своя сессия уже могла завершиться.
      }
    }

    try { child.kill(signal); } catch { /* уже завершён */ }
  };
  const term = () => {
    signalGroup('SIGTERM');
    killTimer ??= setTimeout(() => signalGroup('SIGKILL'), 5000);
  };
  const interrupt = () => {
    signalGroup('SIGINT');
  };

  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);

  try {
    if (child.pid) {
      if (childOwnsSession) {
        await lease.attachSession(child.pid).catch(() => {});
      }

      try {
        await lease.attachChild(child.pid);
      } catch {
        // Быстрый probe мог уже выйти; session record остаётся до проверки потомков.
      }
    }

    return await closed;
  } finally {
    if (killTimer) {
      clearTimeout(killTimer);
    }

    for (;;) {
      try {
        await lease.release();
        break;
      } catch (error) {
        if (!(error instanceof InstallEnvironmentError) || error.code !== 'provider_in_use') {
          throw error;
        }

        await pause(100);
      }
    }

    process.off('SIGTERM', term);
    process.off('SIGINT', interrupt);
  }
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    const code = error instanceof InstallEnvironmentError ? error.code : 'cli_lease_failed';

    process.stderr.write(`GrigDesk: ${code}\n`);
    process.exitCode = 78;
  });
}
