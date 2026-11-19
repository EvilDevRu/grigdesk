import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  addRuntimeLeaseOwner,
  createRuntimeLeaseLocked,
  readProcessOwner,
  releaseRuntimeLeaseOwner,
  withPackageLock,
  PACKAGE_ID,
} from '../src/binary/leases.ts';
import {
  assertPhysicalRuntimePath, bindFactoryRuntime, commitLegacyFactoryRuntime,
} from '../src/lib/factoryRuntimePins.ts';
import {
  assertLegacyRuntimeContextFd, readLegacyRuntimeContext,
} from '../src/lib/factoryLegacyRuntimeContext.ts';
import { isDirectRun } from '../src/lib/helperEntry.ts';
import { configureDarwinBuildProcessHelper } from '../../shared/node/processIdentity.ts';

/**
 * Scope leader живёт рядом с engine child и записывает обе kernel identities.
 * При смерти сервера или wrapper живой engine удерживает поколение собственной lease.
 */
async function runEngine(argv: string[]): Promise<number> {
  const [flag, cacheDir, idFlag, packageId, engineFlag, engine, separator, ...args] = argv;

  if (flag !== '--cache-dir' || !cacheDir || idFlag !== '--package-id'
    || !PACKAGE_ID.test(packageId ?? '') || engineFlag !== '--engine' || !engine
    || separator !== '--' || args.length === 0) {
    return 2;
  }

  const needsContext = process.platform === 'darwin' && args.includes('--require-host-runtime-context');

  if (needsContext) {
    assertLegacyRuntimeContextFd();
  }

  await configureRuntimeProcessHelper();

  await assertPhysicalRuntimePath(path.join(cacheDir, 'packages', packageId!));
  await assertPhysicalRuntimePath(engine, false);

  const owner = await readProcessOwner(process.pid);
  const lease = await withPackageLock(cacheDir, packageId!, () => createRuntimeLeaseLocked({
    cacheDir,
    packageId: packageId!,
    kind: 'engine',
  }));
  const location = {
    cacheDir,
    packageId: packageId!,
    token: lease.token,
  };
  const child = spawn(engine, args, {
    stdio: needsContext ? ['inherit', 'inherit', 'inherit', 3] : 'inherit',
    env: process.env,
  });

  if (needsContext) {
    closeSync(3);
  }

  const closed = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const interrupted = process.platform === 'darwin'
        ? signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1 : 1;

      resolve(code ?? interrupted);
    });
  });
  const forwardTerm = () => child.kill('SIGTERM');
  const forwardInt = () => child.kill('SIGINT');

  process.on('SIGTERM', forwardTerm);
  process.on('SIGINT', forwardInt);

  let known = false;

  try {
    if (child.pid) {
      await addRuntimeLeaseOwner({ ...location, ownerPid: child.pid }).then(() => {
        known = true;
      }).catch(() => {});
    }

    return await closed;
  } finally {
    process.off('SIGTERM', forwardTerm);
    process.off('SIGINT', forwardInt);

    if (known || child.exitCode !== null || child.signalCode !== null) {
      await releaseRuntimeLeaseOwner({ ...location, owner });
    }
  }
}

/**
 * The packaged helper uses the process probe sealed into the selected runtime.
 * Source fixtures and direct source invocations use the prepared build probe.
 */
async function configureRuntimeProcessHelper(): Promise<void> {
  await configureDarwinBuildProcessHelper({
    GRIGDESK_BUILD_PROCESS_HELPER: process.env.FACTORY_DARWIN_PROCESS_HELPER
      ?? process.env.GRIGDESK_BUILD_PROCESS_HELPER,
    GRIGDESK_BUILD_PROCESS_HELPER_SHA256: process.env.FACTORY_DARWIN_PROCESS_HELPER_SHA256
      ?? process.env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256,
  });
}

/**
 * Writer короткого решения читает контекст только из FD 3.
 * При отмене проверка сигнала ограничивает ожидание lock и дальнейшие записи.
 */
async function commitLegacy(argv: string[], commit: LegacyWriter): Promise<number> {
  const [task, attempt, profile, controlRoot] = argv;

  if (process.platform !== 'darwin' || argv.length !== 4 || !task || !attempt || !profile || !controlRoot) {
    return 2;
  }

  const controller = new AbortController();
  const interrupt = () => controller.abort(130);
  const terminate = () => controller.abort(143);
  const deadline = AbortSignal.timeout(30_000);
  const signal = AbortSignal.any([controller.signal, deadline]);

  process.once('SIGTERM', terminate);
  process.once('SIGINT', interrupt);

  try {
    const context = await readLegacyRuntimeContext({
      task,
      attempt,
      profile,
      controlRoot,
    }, signal);

    if (await realpath(process.execPath) !== context.selected.node
      || await realpath(process.argv[1]!) !== context.helper) {
      throw Object.assign(new Error('Выбранный runtime writer изменился'), {
        code: 'factory_runtime_context_invalid',
      });
    }

    await configureRuntimeProcessHelper();

    const pin = await commit({ ...context, signal }, commitLegacyFactoryRuntime);

    process.stdout.write(JSON.stringify(pin) + '\n');

    return 0;
  } catch (error) {
    if (signal.aborted) {
      return controller.signal.aborted ? controller.signal.reason as number : 124;
    }

    throw error;
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
  }
}

type LegacyWriter = (input: Parameters<typeof commitLegacyFactoryRuntime>[0],
  write: typeof commitLegacyFactoryRuntime) => ReturnType<typeof commitLegacyFactoryRuntime>;

/**
 * Host helper публикует authority/index после допуска движка под lock оркестратора.
 * Обычный CLI использует штатный commit. Фикстура может удержать durable границу
 * через параметр функции, без команды или переменной окружения для этого порта.
 */
export async function main(argv = process.argv.slice(2),
  commit: LegacyWriter = commitLegacyFactoryRuntime): Promise<number> {
  if (argv[0] === 'commit-legacy') {
    return commitLegacy(argv.slice(1), commit).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;

      process.stderr.write(`FACTORY_ERROR=${typeof code === 'string' && code.startsWith('factory_runtime_')
        ? code : 'factory_runtime_pin_invalid'}\n`);

      return 78;
    });
  }

  if (argv[0] === 'run') {
    return runEngine(argv.slice(1)).catch((error: NodeJS.ErrnoException) => {
      process.stderr.write(`FACTORY_ERROR=${error.code ?? 'factory_runtime_pin_invalid'}\n`);

      return 78;
    });
  }

  if (argv.length !== 9 || argv[0] !== 'bind' || argv[1] !== '--reservation'
    || argv[3] !== '--task' || argv[5] !== '--attempt' || argv[7] !== '--attempt-dir'
    || !argv[2]?.startsWith('/') || !/^[1-9][0-9]{0,18}$/u.test(argv[4] ?? '')
    || !/^a_[a-f0-9]{32}$/u.test(argv[6] ?? '') || !argv[8]?.startsWith('/')) {
    process.stderr.write('Неверные аргументы привязки runtime попытки\n');

    return 2;
  }

  try {
    await configureRuntimeProcessHelper();
    await bindFactoryRuntime({
      reservation: argv[2],
      task: argv[4]!,
      attempt: argv[6]!,
      attemptDir: argv[8],
    });

    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'factory_runtime_pin_invalid';

    process.stderr.write(`FACTORY_ERROR=${code}\n`);

    return 78;
  }
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
