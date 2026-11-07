import type { ReleaseIdentity } from '../../shared/runtime/installedUpdateContracts.ts';
import { installationForExecutable, readUpdateProcess } from '../../shared/node/updateProcessOwner.ts';
import { inspectInstalledServer, inspectUpdateActivity, installedServerUnit,
  startInstalledServer } from '../../shared/node/installedServer.ts';
import { createUpdateHandoff, launchUpdateWorker, waitUpdateWorker,
  writeDesktopBootProof, resumeDesktopHandoff } from '../../shared/node/installedUpdateWorker.ts';
import type { ServerApi } from '../../shared/runtime/releaseCompatibility.ts';
import { createApplicationUpdates } from './applicationUpdates.ts';
import { desktopText } from './locale.ts';

interface InstalledApplicationPorts {
  executable: string;
  identity: ReleaseIdentity | null;
  localSelected(): boolean;
  ownsLocal(): boolean;
  remoteApi(): ServerApi | null;
  confirm(message: string): Promise<boolean>;
  drainLogs(): Promise<void>;
  save(): Promise<void>;
  flushCookies(): Promise<void>;
  exit(): Promise<void>;
}

/**
 * Готовое приложение получает updater из физического пути и запечатанного build identity.
 * Source и прежний переносимый запуск не объявляют неподдерживаемую capability.
 * Повреждённая установка запрещает только самообновление, но не запуск окна:
 * подключение к удалённому серверу остаётся возможным (инвариант runtimeConfig).
 */
export async function createInstalledApplication(ports: InstalledApplicationPorts) {
  if (!ports.identity) {
    return null;
  }

  let receipt: Awaited<ReturnType<typeof installationForExecutable>> = null;

  try {
    receipt = await installationForExecutable(ports.executable);
  } catch (error) {
    console.warn('installed-update-disabled',
      error instanceof Error ? error.message : 'installation_read_failed');

    return null;
  }

  if (!receipt || receipt.mode === 'server') {
    return null;
  }

  const updates = createApplicationUpdates({
    root: receipt.root,
    runningVersion: ports.identity.version,
    localSelected: () => receipt.mode === 'local' && ports.localSelected(),
    prepare: (job) => launchUpdateWorker(receipt.root, job.id, 'prepare'),
    /**
     * Обновление показывает свежую активность только той местной установки, которую остановит.
     * Ready сохраняется при отказе; обычные настройки выхода не заменяют это согласие.
     */
    async apply(job) {
      const stopLocal = job.scope === 'pair' || ports.ownsLocal();
      const owner = stopLocal ? await inspectInstalledServer(receipt) : null;
      const activity = owner?.running ? await inspectUpdateActivity(receipt) : null;
      const message = desktopText('settings.appUpdateActivity', {
        active: activity?.active ?? 0,
        queued: activity?.queued ?? 0,
        tasks: activity?.tasks.length ?? 0,
      }) + '\n\n' + desktopText('settings.appUpdateConsequences');

      if (!await ports.confirm(message)) {
        return;
      }

      if ((job.scope === 'pair') !== (receipt.mode === 'local' && ports.localSelected())) {
        throw new Error('release_return_to_confirmed_profile');
      }

      const handoff = await createUpdateHandoff(receipt.root, job.id, {
        desktop: await readUpdateProcess(process.pid),
        stopLocal,
        remoteApi: ports.remoteApi(),
      });

      await launchUpdateWorker(receipt.root, job.id);
      await waitUpdateWorker(receipt.root, handoff, 'accepted');
      await waitUpdateWorker(receipt.root, handoff, 'drained');
      await ports.save();
      await ports.flushCookies();
      await ports.drainLogs();
      await ports.exit();
    },
    /**
     * Прерванное применение восстанавливается тем же helper после нового согласия на выход.
     * Живой worker не допускает второй handoff; подготовленные поколения сохраняются.
     */
    async recover(job) {
      if (!await ports.confirm(desktopText('settings.appUpdateRecoveryConsequences'))) {
        return;
      }

      const handoff = await resumeDesktopHandoff(receipt.root, job.id);

      await launchUpdateWorker(receipt.root, job.id, 'recover');
      await waitUpdateWorker(receipt.root, handoff, 'accepted');
      await waitUpdateWorker(receipt.root, handoff, 'drained');
      await ports.save();
      await ports.flushCookies();
      await ports.drainLogs();
      await ports.exit();
    },
  });

  await updates.start();

  return {
    ...updates,
    /**
     * Проверенный unit имеет приоритет над child даже в состоянии inactive.
     * При отсутствии своей службы прежний supervisor продолжает обычный путь child.
     */
    async ensureService() {
      if (receipt.mode !== 'local' || !await installedServerUnit(receipt)) {
        return false;
      }

      await startInstalledServer(receipt);

      return true;
    },
    bootProof: () => writeDesktopBootProof(receipt.root, ports.identity!),
  };
}
