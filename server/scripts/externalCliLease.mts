import { spawn } from 'node:child_process';
import { closeSync, createReadStream, fstatSync, promises as fs, writeSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { once } from 'node:events';
import type { StdioOptions } from 'node:child_process';
import { Writable } from 'node:stream';

import {
  configureDarwinProcessHelper, darwinFactoryToolEnvironment, readDarwinProcessIdentity,
  signalDarwinBuildMember, type DarwinProcessIdentity,
} from '../../shared/node/processIdentity.ts';

import { isDirectRun } from '../src/lib/helperEntry.ts';
import { executableIdentity } from '../src/lib/providerInstall/executableIdentity.ts';
import { acquireCliLease } from '../src/lib/providerInstall/leases.ts';
import { InstallEnvironmentError } from '../src/lib/providerInstall/npmEnvironment.ts';
import { runtimeKind, runtimeRoot } from '../src/lib/runtimePaths.ts';
import { inspectDarwinSession } from '../src/lib/factoryDarwinSessions.ts';
import {
  reserveDarwinExternalProvider, waitDarwinExternalProvider,
} from '../src/lib/providerInstall/darwinExternalProvider.ts';

/**
 * Стадийный протокол передаёт статус и события отдельными fd выше 2.
 * Хелпер обязан пропустить их в CLI, иначе factory-стадия теряет отчёт инструмента.
 */
async function inheritedStdio(graphPermit = false): Promise<StdioOptions> {
  if (graphPermit) {
    return ['inherit', 'inherit', 'inherit'];
  }
  if (process.platform === 'darwin') {
    const inherited: StdioOptions = ['inherit', 'inherit', 'inherit'];

    if (process.env.FACTORY_RUN_TASK && process.env.FACTORY_STATUS_MODE !== 'request') {
      const status = fstatSync(7);

      if (!status.isFile() || status.uid !== process.getuid!() || (status.mode & 0o7777) !== 0o600) {
        throw new Error('darwin_external_provider_status_fd_invalid');
      }

      inherited.push('ignore', 'ignore', 'ignore', 'ignore', 'inherit');
    }

    return inherited;
  }

  const fds = (await fs.readdir('/proc/self/fd'))
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number)
    .filter((fd) => fd >= 3 && fd <= 64);
  const max = Math.max(2, ...fds);

  return Array.from({ length: max + 1 }, (_, fd) =>
    fd < 3 || fds.includes(fd) ? 'inherit' : 'ignore');
}


/**
 * Графовый scope сообщает свою identity по fd 11 и ждёт единственный permit byte.
 * EOF, посторонние байты и тайм-аут прекращают запуск до вызова провайдера.
 */
async function graphPermitHandshake(): Promise<boolean> {

  try {
    writeSync(11, JSON.stringify({ pid: process.pid }) + '\n');
  } catch {
    return false;
  }
  const stream = createReadStream('', { fd: 10, autoClose: true });
  const timer = new AbortController();

  try {
    const byte = await Promise.race([
      new Promise<number>((resolve) => {
        stream.once('data', (chunk: string | Buffer) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

          resolve(buffer.length > 0 ? buffer[0]! : -1);
        });
        stream.once('end', () => resolve(-1));
        stream.once('error', () => resolve(-1));
      }),
      pause(5000, undefined, { signal: timer.signal }).then(() => -1).catch(() => -1),
    ]);

    return byte === 1;
  } finally {
    timer.abort();
    stream.destroy();
    try { closeSync(11); } catch { /* уже закрыт */ }
  }
}

/** Отдельная сессия CLI принимает сигнал только по подтверждённым участникам. */
async function signalDarwinProvider(identity: DarwinProcessIdentity, signal: 'TERM' | 'INT' | 'KILL') {
  const current = await inspectDarwinSession(identity, undefined, [], true);

  if (current.state === 'alive') {
    await Promise.all(current.members.map((member) =>
      signalDarwinBuildMember(member, signal, AbortSignal.timeout(2500))));
  }
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

  // Флаги читаются парно до «--»: метка разговора приходит только от живой
  // сессии чата, а probe и usage запускают helper без неё.
  let directory = '';
  let providerId = '';
  let resourceKey = '';
  let chatKey: string | null = null;
  let graphPermit = false;
  let index = 0;

  for (; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === '--' || flag === undefined) {
      break;
    }
    if (flag === '--graph-permit') {
      if (value !== '1') {
        return 2;
      }
      graphPermit = true;
      continue;
    }
    if (!['--lease-dir', '--provider', '--resource', '--job'].includes(flag)
      || typeof value !== 'string') {
      return 2;
    }
    if (flag === '--job') {
      if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(value)) {
        return 2;
      }

      chatKey = value;
    } else if (flag === '--lease-dir') {
      directory = value;
    } else if (flag === '--provider') {
      providerId = value;
    } else {
      resourceKey = value;
    }
  }

  const [separator, command, ...args] = argv.slice(index);

  if (!directory || !path.isAbsolute(directory) || !providerId || !resourceKey
    || separator !== '--' || !command || !path.isAbsolute(command)) {
    return 2;
  }

  const darwin = process.platform === 'darwin';
  let owner: DarwinProcessIdentity | null = null;
  let setsid = '';
  let sessionId: number;

  if (darwin) {
    const tools = await darwinFactoryToolEnvironment({ root: runtimeRoot(), packaged: runtimeKind() === 'packaged' });

    await configureDarwinProcessHelper(tools.FACTORY_DARWIN_PROCESS_HELPER!,
      tools.FACTORY_DARWIN_PROCESS_HELPER_SHA256!);
    const processOwner = await readDarwinProcessIdentity(process.pid);

    if (processOwner.state !== 'alive') {
      throw new Error('darwin_external_provider_scope_invalid');
    }

    owner = processOwner.identity;
    sessionId = owner.sid;
    setsid = tools.FACTORY_DARWIN_SETSID!;
  } else {
    const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u);

    sessionId = Number(fields[3]);
    if (graphPermit) {
      const info = await fs.stat('/proc/self');

      if (Number(fields[2]) !== process.pid || sessionId !== process.pid
        || info.uid !== process.getuid!()) {
        process.stderr.write('GrigDesk: graph_permit_session_invalid\n');
        return 78;
      }
    }
  }

  if (graphPermit && darwin && owner && (owner.pid !== process.pid || owner.sid !== process.pid)) {
    process.stderr.write('GrigDesk: graph_permit_session_invalid\n');
    return 78;
  }

  if (graphPermit) {
    const permitted = await graphPermitHandshake();

    if (!permitted) {
      process.stderr.write('GrigDesk: graph_permit_denied\n');
      return 78;
    }
  }

  const stdio = await inheritedStdio(graphPermit);
  const lease = await acquireCliLease({
    directory,
    providerId,
    resourceKey,
    mode: 'reader',
    sessionId: sessionId === process.pid ? sessionId : undefined,
    jobId: chatKey ?? undefined,
  });

  if (expectedIdentity && await executableIdentity(command).catch(() => null) !== expectedIdentity) {
    await lease.release();

    throw new InstallEnvironmentError('installation_changed', 'Выбранная программа изменилась');
  }

  // Helper-лидер уже владеет сессией: CLI остаётся в его группе и умирает вместе с ней.
  // В factory helper не лидер, поэтому CLI получает собственную сессию для учёта потомков.
  const childOwnsSession = sessionId !== process.pid;
  const binding = owner ? await reserveDarwinExternalProvider(owner).catch(async (error) => {
    await lease.release();

    throw error;
  }) : null;
  const held = darwin && childOwnsSession;

  if (held && Array.isArray(stdio)) {
    while (stdio.length < 9) {
      stdio.push('ignore');
    }
    stdio.push('pipe');
  }

  const child = spawn(held ? setsid : command, held ? ['--permit-fd', '9', '--', command, ...args] : args, {
    stdio,
    env: process.env,
    detached: !darwin && childOwnsSession,
  });
  const closed = new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
  });
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeChild: DarwinProcessIdentity | null = null;
  let interrupted = false;

  /**
   * Своя сессия CLI завершается группой; в общей сессии сигнал получает сам процесс.
   * Это сохраняет SIGTERM/SIGKILL-поведение timeout и не задевает чужие процессы.
   */
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) {
      return;
    }
    if (darwin) {
      interrupted = true;
      if (nativeChild) {
        const action = signal === 'SIGINT' ? 'INT' : signal === 'SIGKILL' ? 'KILL' : 'TERM';

        void signalDarwinProvider(nativeChild, action).catch(() => {});
      } else if (!held) {
        child.kill(signal);
      }

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
    if (held && child.pid) {
      const permit = child.stdio.at(9);

      if (!(permit instanceof Writable)) {
        throw new Error('external_cli_hold_permit_missing');
      }

      try {
        nativeChild = await waitDarwinExternalProvider(child.pid, AbortSignal.timeout(3500));
        await binding?.bind(nativeChild);
        await lease.attachSession(nativeChild.sid);
        await lease.attachChild(nativeChild.pid);
        if (interrupted) {
          return 143;
        }
        const accepted = once(permit, 'finish');

        permit.end(Buffer.from([1]));
        await accepted;
      } finally {
        permit.end();
        if (interrupted) {
          await closed;
        }
      }
    } else if (child.pid) {
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

    // Осиротевший потомок CLI может держать сессию сколь угодно долго: без верхней
    // границы helper сам становился бы вечным процессом. Запись при таймауте
    // остаётся и снимается следующим inspect/acquire либо подтверждённым закрытием.
    const releaseDeadline = Date.now() + 120_000;

    for (;;) {
      try {
        await lease.release();
        await binding?.release();
        break;
      } catch (error) {
        if (!(error instanceof InstallEnvironmentError) || error.code !== 'provider_in_use') {
          throw error;
        }
        if (Date.now() >= releaseDeadline) {
          process.stderr.write('GrigDesk: cli_lease_release_timeout\n');
          break;
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
