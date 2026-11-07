import { randomUUID } from 'node:crypto';

import type { ApplicationUpdatePort, ApplicationUpdateSnapshot }
  from '../../shared/runtime/applicationUpdateContracts.ts';
import { InstalledUpdateService } from '../../shared/node/installedUpdateService.ts';
import type { InstalledUpdateJob } from '../../shared/node/installedUpdateState.ts';
import { compareProductVersions } from '../../shared/runtime/productReleaseVersion.ts';

interface ApplicationUpdateOptions {
  root: string;
  runningVersion: string;
  localSelected(): boolean;
  prepare(job: InstalledUpdateJob): Promise<void>;
  apply(job: InstalledUpdateJob): Promise<void>;
  recover?(job: InstalledUpdateJob): Promise<void>;
}

/**
 * Сервис принадлежит установке и живёт независимо от транспорта выбранной машины.
 * Сеть запускается после локального снимка и никогда не задерживает первый shell state.
 */
export function createApplicationUpdates(options: ApplicationUpdateOptions) {
  const service = new InstalledUpdateService(options.root);
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let autoTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let preparing = false;
  let snapshot: ApplicationUpdateSnapshot = {
    channel: 'release',
    running: options.runningVersion,
    targetVersion: null,
    notes: null,
    scope: options.localSelected() ? 'pair' : 'desktop',
    checkState: 'unknown',
    checkedAt: null,
    error: null,
    job: null,
  };

  /**
   * Один снимок уведомляет существующий shell long-poll только при реальном изменении.
   * Внешние процессы не получают слушателей и не продлевают жизнь закрытому main.
   */
  function publish(next: ApplicationUpdateSnapshot): void {
    if (disposed || JSON.stringify(next) === JSON.stringify(snapshot)) {
      return;
    }

    snapshot = next;

    for (const changed of listeners) {
      changed();
    }
  }

  /**
   * Публичная проекция исключает receipt, пути, подпись и полный приватный journal.
   * Смена профиля меняет предлагаемый scope, но уже созданное задание сохраняет свой.
   */
  async function refresh(): Promise<void> {
    let status;

    try {
      status = await service.status();
    } catch (error) {
      publish({
        ...snapshot,
        checkState: 'error',
        error: error instanceof Error ? error.message : 'release_state_invalid',
      });

      return;
    }

    const job = status.job;
    let checkState = status.check.state;

    if (!options.localSelected() && ['current', 'available'].includes(checkState)) {
      checkState = status.check.envelope && status.installed.desktop
        && compareProductVersions(status.check.envelope.payload.version, status.installed.desktop) > 0
        ? 'available' : 'current';
    }

    const next: ApplicationUpdateSnapshot = {
      channel: status.channel,
      running: options.runningVersion,
      targetVersion: job?.envelope.payload.version ?? status.check.envelope?.payload.version ?? null,
      notes: job ? job.envelope.payload.notes : status.check.envelope?.payload.notes ?? null,
      scope: job?.scope === 'pair' || !job && options.localSelected() ? 'pair' : 'desktop',
      checkState,
      checkedAt: status.check.checkedAt,
      error: job?.error?.code ?? status.check.error,
      job: job && job.scope !== 'server' ? {
        id: job.id,
        stage: job.stage,
        version: job.envelope.payload.version,
        scope: job.scope,
        downloadedBytes: job.progress?.downloadedBytes ?? null,
        totalBytes: job.progress?.totalBytes ?? null,
        nextAction: job.error?.nextAction ?? null,
        recoverable: !status.workerActive,
      } : null,
    };

    publish(next);
  }

  /**
   * Сайт опрашивается отдельно от локального журнала; ошибка остаётся состоянием error.
   * Таймеры не удерживают desktop и снимаются вместе с оболочкой.
   */
  async function check(): Promise<void> {
    const flight = service.checkUpdates();

    await refresh();

    try {
      await flight;
    } finally {
      await refresh();
    }
  }

  const port: ApplicationUpdatePort = {
    state: () => snapshot,
    subscribe: (changed) => {
      listeners.add(changed);

      return () => listeners.delete(changed);
    },
    /**
     * Renderer передаёт только закрытую форму действий, не executable или root установки.
     * Target сверяется main-процессом, повтор prepare при потерянном ответе возвращает тот же job.
     */
    async action(action, body) {
      if (action === 'check' && Object.keys(body).length === 0) {
        await check();

        return;
      }

      if (action === 'channel' && Object.keys(body).length === 1
        && (body.channel === 'release' || body.channel === 'dev')) {
        await service.setChannel(body.channel);
        await check();

        return;
      }

      if (action === 'prepare' && Object.keys(body).length === 0) {
        if (preparing) {
          return;
        }

        preparing = true;

        try {
          const status = await service.status();
          const previous = status.job;

          const pending = ['queued', 'verifying', 'downloading', 'preparing', 'ready'];

          if (previous && pending.includes(previous.stage)) {
            await refresh();

            return;
          }

          if (snapshot.checkState !== 'available' || !status.check.manifestDigest) {
            throw new Error('release_check_required');
          }

          const job = await service.manager().createJob({
            requestId: randomUUID(),
            manifestDigest: status.check.manifestDigest,
            scope: options.localSelected() ? 'pair' : 'desktop',
          });

          await options.prepare(job);
          await refresh();
        } finally {
          preparing = false;
        }

        return;
      }

      if (action === 'apply' && Object.keys(body).length === 1 && body.confirmed === true) {
        const job = (await service.status()).job;

        if (!job || job.stage !== 'ready' || (job.scope === 'pair') !== options.localSelected()) {
          throw new Error('release_return_to_confirmed_profile');
        }

        await options.apply(job);

        return;
      }

      if (action === 'resume' && Object.keys(body).length === 0) {
        const job = (await service.status()).job;

        if (!job || (job.scope === 'pair') !== options.localSelected()) {
          throw new Error('release_return_to_confirmed_profile');
        }

        if (['failed', 'queued', 'verifying', 'downloading', 'preparing'].includes(job.stage)) {
          await options.prepare(job);
        } else if (options.recover && ['stopping', 'applying', 'starting',
          'manual_recovery_required'].includes(job.stage)) {
          await options.recover(job);
        } else {
          throw new Error('release_recovery_not_available');
        }

        await refresh();

        return;
      }

      throw new Error('release_action_invalid');
    },
  };

  return {
    port,
    /**
     * Локальный journal доступен раньше сети, подготовленные байты сохраняются между запусками.
     * Ошибка чтения не уничтожает journal и не скрывается под отсутствием обновлений.
     */
    async start() {
      await refresh();
      timer = setInterval(() => void refresh().catch(() => {}), 1000);
      autoTimer = setInterval(() => void check().catch(() => {}), 6 * 60 * 60_000);
      timer.unref();
      autoTimer.unref();
      void check().catch(() => {});
    },
    /**
     * Закрытие владельца освобождает таймеры и подписчиков без отмены сохранённого задания.
     * Подготовкой и применением продолжает владеть внешний helper.
     */
    close() {
      disposed = true;
      clearInterval(timer ?? undefined);
      clearInterval(autoTimer ?? undefined);
      listeners.clear();
    },
  };
}
