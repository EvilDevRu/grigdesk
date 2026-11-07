import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  addRuntimeLeaseOwner,
  createRuntimeLeaseLocked,
  readProcessOwner,
  releaseRuntimeLeaseOwner,
  withPackageLock,
  PACKAGE_ID,
} from '../src/binary/leases.ts';
import { assertPhysicalRuntimePath } from '../src/lib/factoryRuntimePins.ts';
import { bindFactoryRuntime } from '../src/lib/factoryRuntimePins.ts';
import { isDirectRun } from '../src/lib/helperEntry.ts';

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
  const child = spawn(engine, args, { stdio: 'inherit', env: process.env });
  const closed = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
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
 * Host helper вызывается движком только под его attempt lock после final directory.
 * Он пишет sidecar authority/index, но никогда не меняет курсор, result или каталог маршрута.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
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
