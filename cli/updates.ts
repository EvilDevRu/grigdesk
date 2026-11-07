import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as pause } from 'node:timers/promises';

import type { CliArgs } from './args.ts';
import { cliTranslator } from './i18n.ts';
import { insideUnit, insideWindowScope } from './cgroup.ts';
import { InstalledUpdateService } from '../shared/node/installedUpdateService.ts';
import { readInstallation } from '../shared/node/installedLayout.ts';
import { readInstalledUpdate } from '../shared/node/installedUpdateState.ts';
import { PENDING_UPDATE_STAGES } from '../shared/node/installedUpdateState.ts';
import { createUpdateHandoff, launchUpdateWorker, waitUpdateWorker }
  from '../shared/node/installedUpdateWorker.ts';
import { inspectInstalledServer, inspectUpdateActivity, INSTALLED_SERVER_UNIT }
  from '../shared/node/installedServer.ts';

export interface UpdateOutput {
  write(text: string): void;
  error(text: string): void;
}

const ROLLBACK_STAGES = ['applied_not_started', 'stopping', 'applying', 'starting',
  'manual_recovery_required'];
const PREPARE_STAGES = ['queued', 'verifying', 'downloading', 'preparing', 'failed'];
const PREPARE_STALL_MS = 120000;

/**
 * Тот же cgroup-сторож, что у stop/restart: остановка сервера из хода агента
 * или окна убьёт сам сеанс. Интерактивное подтверждение не отменяет сторож.
 */
async function assertOutsideOwnerScope(args: CliArgs): Promise<void> {
  if (args.force) {
    return;
  }

  const cgroup = await fs.readFile('/proc/self/cgroup', 'utf8');

  if (insideUnit(cgroup, INSTALLED_SERVER_UNIT) || insideWindowScope(cgroup)) {
    throw new Error('release_command_inside_owner_use_force');
  }
}

/**
 * Человекочитаемое продолжение для ожидаемых кодов ожидания: сам код остаётся
 * в json-режиме, текст ошибки подсказывает следующее действие.
 */
function failureText(code: string, t: (key: string, params?: Record<string, string>) => string): string {
  const friendly: Record<string, string> = {
    release_apply_pending_check_status: t('updates.applyTimeout'),
    release_prepare_stalled_check_status: t('updates.prepareStalled'),
  };

  return friendly[code] ?? t('updates.failure', { code });
}

/**
 * Команды работают с приватным журналом установки без HTTP и запущенного сервера.
 * Подготовка не запускает stopped server; server-only не меняет local-пару наполовину.
 */
export async function runUpdateCommand(args: CliArgs, root: string, output: UpdateOutput): Promise<number> {
  const service = new InstalledUpdateService(root);
  const { t } = cliTranslator();

  try {
    let status = await service.status();

    if (args.action === 'update-channel') {
      await service.setChannel(args.channel!);
      status = await service.status();
    } else if (args.action === 'check-updates' || args.action === 'update'
      && (!status.job || !PENDING_UPDATE_STAGES.includes(status.job.stage))) {
      await service.checkUpdates();
      status = await service.status();
    }

    if (args.action === 'update' || args.action === 'resume-update') {
      if (status.mode !== 'server') {
        throw new Error('pair_update_required');
      }

      let job = status.job;

      if (args.action === 'update' && (!job || !PENDING_UPDATE_STAGES.includes(job.stage))) {
        if (status.check.state === 'error') {
          throw new Error(status.check.error!);
        }

        if (status.check.state !== 'available') {
          output.write(t('updates.current') + '\n');

          return 0;
        }

        job = await service.manager().createJob({
          requestId: randomUUID(),
          scope: 'server',
          manifestDigest: status.check.manifestDigest!,
        });
      }

      if (!job) {
        throw new Error('release_job_missing');
      }

      const receipt = await readInstallation(root);

      if (args.rollback && !ROLLBACK_STAGES.includes(job.stage)) {
        throw new Error('release_recovery_not_available');
      }

      if (PREPARE_STAGES.includes(job.stage)) {
        if (!status.workerActive) {
          await launchUpdateWorker(root, job.id, 'prepare');
        }

        let lastStage = job.stage;
        let stageChangedAt = Date.now();

        while (true) {
          const current = await readInstalledUpdate(receipt);

          if (!current || current.id !== job.id) {
            throw new Error('release_job_mismatch');
          }

          if (!args.json) {
            const progress = current.stage === 'downloading' && current.progress?.totalBytes
              ? ` ${Math.floor(current.progress.downloadedBytes * 100 / current.progress.totalBytes)}%` : '';

            output.write(t('updates.job', {
              version: current.envelope.payload.version, stage: t(`updates.stage_${current.stage}`),
            }) + progress + '\n');
          }

          if (current.stage !== lastStage) {
            lastStage = current.stage;
            stageChangedAt = Date.now();
          }

          job = current;

          if (current.stage === 'failed') {
            throw new Error(current.error?.code ?? 'release_prepare_failed');
          }

          if (current.stage === 'ready') {
            break;
          }

          if (Date.now() - stageChangedAt >= PREPARE_STALL_MS
            && !(await service.status()).workerActive) {
            throw new Error('release_prepare_stalled_check_status');
          }

          await pause(500);
        }
      }

      let confirmed = args.restart === true || args.rollback === true;
      const interactive = !args.json && process.stdin.isTTY && process.stdout.isTTY;

      if (confirmed || interactive) {
        await assertOutsideOwnerScope(args);

        const owner = await inspectInstalledServer(receipt);
        const activity = owner.running ? await inspectUpdateActivity(receipt) : null;

        if (!args.json) {
          output.write(t('updates.activity', {
            active: activity?.active ?? 0,
            queued: activity?.queued ?? 0,
            tasks: activity?.tasks.length ?? 0,
          }) + '\n');
        }

        if (!confirmed && interactive
          && (job.stage === 'ready' || args.rollback)) {
          const prompt = createInterface({ input: process.stdin, output: process.stdout });

          try {
            const question = args.rollback
              ? t('updates.rollbackPrompt') : t('updates.restartPrompt');

            confirmed = (await prompt.question(question)).trim().toLowerCase() === 'y';
          } finally {
            prompt.close();
          }
        }
      }

      if (confirmed) {
        if (args.rollback) {
          await launchUpdateWorker(root, job.id, 'rollback');
        } else if (job.stage === 'ready') {
          const handoff = await createUpdateHandoff(root, job.id, { stopLocal: true });

          await launchUpdateWorker(root, job.id);
          await waitUpdateWorker(root, handoff, 'accepted');
        } else if (['stopping', 'applying', 'starting', 'manual_recovery_required',
          'applied_not_started'].includes(job.stage)) {
          await launchUpdateWorker(root, job.id, 'recover');
        }

        const deadline = Date.now() + 240000;
        let finished = false;

        while (Date.now() < deadline) {
          const current = await readInstalledUpdate(receipt);
          const succeeded = args.rollback
            ? current?.stage === 'rolled_back'
            : current && ['completed', 'applied_not_started'].includes(current.stage);

          if (succeeded) {
            finished = true;
            break;
          }

          const failed = current && (['failed', 'rolled_back', 'manual_recovery_required']
            .includes(current.stage) || current.stage === 'ready' && !current.intent);

          if (failed) {
            throw new Error(current.error?.code ?? 'release_apply_failed');
          }

          await pause(300);
        }

        if (!finished) {
          throw new Error('release_apply_pending_check_status');
        }
      }

      status = await service.status();
    }

    if (args.json) {
      output.write(JSON.stringify(status) + '\n');
    } else {
      output.write(t('updates.status', {
        version: status.installed.server ?? '—',
        channel: status.channel,
        state: t(`updates.${status.check.state}`),
      }) + '\n');

      if (status.job) {
        output.write(t('updates.job', {
          version: status.job.envelope.payload.version,
          stage: t(`updates.stage_${status.job.stage}`),
        }) + '\n');
      }
    }

    return status.check.state === 'error' ? 1 : 0;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'release_update_failed';

    if (args.json) {
      output.write(JSON.stringify({ error: code, nextAction: 'update-status' }) + '\n');
    } else {
      output.error(failureText(code, t) + '\n');
    }

    return 1;
  }
}
