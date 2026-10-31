import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ApplyFs } from './applyPackage.ts';
import { installError } from './errors.ts';
import type { DirectoryIdentity, PackageRemovalIntent, PluginInstallStateStore } from './stateStore.ts';

/**
 * Пакет сначала уходит в собственную transaction-папку, оставаясь восстанавливаемым по identity.
 * Повтор после остановки процесса принимает только исходную либо уже перемещённую копию.
 */
async function retireDirectory(
  fs: ApplyFs,
  directory: string,
  transaction: string,
  expected: DirectoryIdentity,
  npmDirs: string[],
): Promise<void> {
  await fs.ensureDir(transaction);

  const retired = path.join(transaction, 'retired');
  const current = await fs.lstatIdentity(directory, npmDirs);
  const parked = await fs.lstatIdentity(retired, npmDirs);

  if (current && !parked && isDeepStrictEqual(current, expected)) {
    await fs.rename(directory, retired);
    await fs.syncDir(path.dirname(directory));
    await fs.syncDir(transaction);
  } else if (current || !isDeepStrictEqual(parked, expected)) {
    throw installError('recovery_required');
  }
}

/**
 * Durable намерение удаляет current и previous до снятия установленной записи из журнала.
 * Cleanup получает право стирать копии только вместе с commit; реквизитов здесь нет.
 */
export async function finishPackageRemoval(
  store: PluginInstallStateStore,
  fs: ApplyFs,
  roots: { pluginsDir: string; workDir: string },
): Promise<void> {
  const intent: PackageRemovalIntent | null = (await store.read()).removal ?? null;

  if (!intent) {
    return;
  }

  const transaction = path.join(roots.workDir, 'transactions', intent.transactionId);
  const previousTransaction = path.join(roots.workDir, 'transactions', intent.previousTransactionId);
  const previous = path.join(roots.workDir, 'previous', intent.pluginId);

  await retireDirectory(fs, path.join(roots.pluginsDir, intent.pluginId),
    transaction, intent.current, intent.npmDirs);

  if (intent.previous) {
    await retireDirectory(fs, previous, previousTransaction, intent.previous, intent.previousNpmDirs);
  } else if (await fs.lstatIdentity(previous)) {
    throw installError('recovery_required');
  }

  await store.mutate((state) => {
    if (state.removal?.transactionId !== intent.transactionId) {
      throw installError('recovery_required');
    }

    delete state.plugins[intent.pluginId];
    delete state.lastRollback[intent.pluginId];

    if (state.job?.pluginId === intent.pluginId) {
      state.job = null;
    }

    state.removedIds = [...new Set([...(state.removedIds ?? []), intent.pluginId])];
    state.removal = null;
    state.cleanup.push({
      kind: 'transaction',
      transactionId: intent.transactionId,
      retired: intent.current,
      npmDirs: intent.npmDirs,
    });

    if (intent.previous) {
      state.cleanup.push({
        kind: 'transaction',
        transactionId: intent.previousTransactionId,
        retired: intent.previous,
        npmDirs: intent.previousNpmDirs,
      });
    }
  });
}
