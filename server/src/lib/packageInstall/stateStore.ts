import type {
  PluginInstallJob,
  PluginInstallRecord,
  PluginVersionRef,
} from '../../../../shared/plugins/pluginInstallContracts.ts';
import type { CommandWorker } from './runCommand.ts';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { installError } from './errors.ts';
import { writeDurableFile } from '../durableFile.ts';
import { decodeInstallState } from './stateValidation.ts';
import { withPathLock } from '../pathLock.ts';

export interface DirectoryIdentity {
  dev: number;
  ino: number;
  payloadDigest?: string;
}

export interface InstallBaseSnapshot {
  record: PluginInstallRecord | null;
  current: DirectoryIdentity | null;
  previous: DirectoryIdentity | null;
}

export interface PreparedInstall {
  jobId: string;
  baseSnapshot: InstallBaseSnapshot;
  candidateDigest: string;
  latest: PluginVersionRef | null;
}

export interface RollbackReceiptInput {
  requestId: string;
  inputHash: string;
  baseRevision: number;
}

export interface PluginApplyIntent {
  transactionId: string;
  pluginId: string;
  jobId: string;
  kind: 'install' | 'update' | 'rollback';
  baseRecord: PluginInstallRecord | null;
  targetRecord: PluginInstallRecord;
  destination: 'previous' | 'replaced' | 'none';
  current: DirectoryIdentity | null;
  candidate: DirectoryIdentity;
  previous: DirectoryIdentity | null;
  reviewToken: string;
  phase: 'prepared' | 'installed' | 'archived';
  rollbackReceiptInput: RollbackReceiptInput | null;
  archiveKey: string | null;
}

export interface PackageRemovalIntent {
  pluginId: string;
  transactionId: string;
  previousTransactionId: string;
  current: DirectoryIdentity;
  previous: DirectoryIdentity | null;
  npmDirs: string[];
  previousNpmDirs: string[];
}

export type CleanupEntry =
  | {
    kind: 'job';
    jobId: string;
    package?: DirectoryIdentity | null;
  }
  | {
    kind: 'transaction';
    transactionId: string;
    retired: DirectoryIdentity | null;
    npmDirs: string[];
  };

export interface RollbackReceipt extends RollbackReceiptInput {
  job: PluginInstallJob;
}

export interface PluginInstallState {
  schemaVersion: 1;
  nextRevision: number;
  plugins: Record<string, PluginInstallRecord>;
  job: PluginInstallJob | null;
  completedJobs: Record<string, PluginInstallJob>;
  apply: PluginApplyIntent | null;
  prepared: PreparedInstall | null;
  cleanup: CleanupEntry[];
  lastRollback: Record<string, RollbackReceipt>;
  workers: Record<string, CommandWorker>;
  removal?: PackageRemovalIntent | null;
  removedIds?: string[];
}

export interface InstallStateOptions {
  statePath: string;
  hasWorkEvidence: () => Promise<boolean>;
  readText?: (file: string) => Promise<string>;
  write?: (file: string, text: string) => Promise<void>;
}

/**
 * Пустое состояние существует только при отсутствии файла и work evidence.
 * Каждый вызов создаёт независимые dictionaries и массивы.
 */
export function emptyInstallState(): PluginInstallState {
  return {
    schemaVersion: 1,
    nextRevision: 1,
    plugins: {},
    job: null,
    completedJobs: {},
    apply: null,
    prepared: null,
    cleanup: [],
    lastRollback: {},
    workers: {},
  };
}

/**
 * Durable store отделён от admission mutex и runtime lifecycle.
 * Чтение не удаляет файлы и не скрывает повреждённый state.
 */
export class PluginInstallStateStore {
  readonly options: InstallStateOptions;

  /**
   * Work evidence проверяется caller в том же проверенном service root.
   * Точки подмены относятся только к filesystem fixture, не к HTTP.
   */
  constructor(options: InstallStateOptions) {
    this.options = options;
  }

  /**
   * Первое требование различает новый сервис и потерянный журнал установки.
   * Непустая рабочая область не может считаться новой пустой установкой.
   */
  async read(): Promise<PluginInstallState> {
    try {
      const info = await lstat(this.options.statePath);

      if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) {
        throw installError('state_invalid');
      }

      const reader = this.options.readText ?? readBoundedStateText;
      const text = await reader(this.options.statePath);

      return decodeInstallState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !await this.options.hasWorkEvidence()) {
        return emptyInstallState();
      }

      throw installError('state_invalid');
    }
  }

  /**
   * Изменение состояния публикуется устойчиво до внешнего ACK.
   * Callback и возвращаемый снимок не должны делить mutable state.
   */
  async mutate(
    change: (state: PluginInstallState) => void | PluginInstallState | Promise<void | PluginInstallState>,
  ): Promise<PluginInstallState> {
    return withPathLock(this.options.statePath, async () => {
      const current = await this.read();
      const next = await change(current) ?? current;

      decodeInstallState(next, true);

      const retained = Object.entries(next.completedJobs)
        .sort(([, a], [, b]) => String(a.finishedAt).localeCompare(String(b.finishedAt)))
        .slice(-32)
        .map(([id, job]) => [id, summarizeInstallJob(job)]);

      next.completedJobs = Object.fromEntries(retained);
      decodeInstallState(next);

      const text = `${JSON.stringify(next)}\n`;

      if (Buffer.byteLength(text) > 10 * 1024 * 1024) {
        throw installError('state_invalid');
      }

      await (this.options.write ?? writeDurableFile)(this.options.statePath, text);

      return structuredClone(next);
    });
  }
}

/**
 * Terminal summary оставляет DTO outcome без тяжёлого diff и shared references.
 * Live job и rollback receipt сохраняются независимо от completedJobs pruning.
 */
export function summarizeInstallJob(job: PluginInstallJob): PluginInstallJob {
  const summary = structuredClone(job);

  if (summary.preview) {
    summary.preview.changes = null;
    summary.preview.description = summary.preview.description.slice(0, 4096);
    summary.preview.warnings = summary.preview.warnings.slice(0, 20).map((text) => text.slice(0, 1024));
  }

  return summary;
}

/**
 * Повтор rollback запроса может прочитать receipt после смерти прежнего HTTP процесса.
 * Lookup не выполняет filesystem операции и возвращает независимый outcome.
 */
export function getRollbackReceipt(
  state: PluginInstallState,
  id: string,
  input: RollbackReceiptInput,
): PluginInstallJob | null {
  const receipt = Object.hasOwn(state.lastRollback, id) ? state.lastRollback[id] : undefined;

  if (!receipt || receipt.requestId !== input.requestId) {
    return null;
  }

  if (receipt.inputHash !== input.inputHash || receipt.baseRevision !== input.baseRevision) {
    throw installError('preview_stale');
  }

  return structuredClone(receipt.job);
}

/**
 * State читается через no-follow descriptor и ограниченный поток, даже при росте файла.
 * Размер JSON проверяется до парсинга, спецфайл не может заблокировать read.
 */
async function readBoundedStateText(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await handle.stat();

  if (!info.isFile() || info.size > 10 * 1024 * 1024) {
    await handle.close();

    throw installError('state_invalid');
  }

  const stream = handle.createReadStream({ autoClose: false });
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);

      size += bytes.length;

      if (size > 10 * 1024 * 1024) {
        throw installError('state_invalid');
      }

      chunks.push(bytes);
    }

    return Buffer.concat(chunks).toString('utf8');
  } finally {
    stream.destroy();
    await handle.close();
  }
}
