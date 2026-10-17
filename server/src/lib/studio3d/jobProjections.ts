// DTO явно отделены от private journal. Файловые ссылки принадлежат libraryId,
// а разрешение платного retry опирается на доказанный исход и retained snapshots.
import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dJob, Studio3dTaskRow } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { IntentChild, IntentRecord, StudioIntents } from './intents.ts';
import type { StudioLibrary } from './library.ts';
import { versionProjection } from './library.ts';
import { retainedInputs } from './jobInputs.ts';
import { summarizeModel } from './search.ts';

export type JobFileUrl = (model: string, version: string, name: string) => string;

/**
 * DTO не включает private код ответа или внутренний stack/system path.
 * Сообщение уже нормализовано исполнителем для безопасного показа человеку.
 */
export function publicJobError(child: IntentChild) {
  return child.error ? {
    kind: child.error.kind,
    message: child.error.message,
    detail: child.error.detail
  } : null;
}

/**
 * Неизвестная отправка и paid success с ошибкой CDN не дают платный retry.
 * Терминальный отказ разрешает новое нажатие лишь пока снимки реально сохранены.
 */
export async function retryInfo(record: IntentRecord, child: IntentChild,
  library: StudioLibrary, intents: StudioIntents): Promise<{ available: boolean; reason: string | null }> {
  if (['unknown', 'unresolved', 'submitting'].includes(child.stage)) {
    return { available: false, reason: 'Заказ мог быть принят и оплачен — сначала разберите исход.' };
  }

  if (child.remote?.state === 'success') {
    return { available: false, reason: 'Генерация завершена; доступно бесплатное скачивание.' };
  }

  const unsubmittedConfirmation = child.stage === 'prepared' && child.confirmationExpired;

  if (!unsubmittedConfirmation && (child.status !== 'failed'
    || !['done', 'rejected'].includes(child.stage))) {
    return { available: false, reason: null };
  }

  if (!await retainedInputs(library, intents, record.intentId, record.inputs)) {
    return { available: false, reason: 'Срок хранения входов истёк — загрузите их заново.' };
  }

  return { available: true, reason: null };
}

/**
 * Replay отвечает сохранённой проекцией, а после удаления — tombstone.
 * Он не требует upload, родителя, нового каталога или прежнего доступа API.
 */
export async function runProjection(record: IntentRecord, library: StudioLibrary,
  intents: StudioIntents, fileUrl: JobFileUrl) {
  let entry = null;

  if (record.modelId) {
    try {
      entry = await library.readModel(record.modelId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const versions = [];

  for (const child of record.children) {
    const version = entry?.versions.find((item) => item.id === child.version?.id);

    if (version && record.modelId) {
      versions.push(versionProjection(version, library.libraryId,
        (name) => fileUrl(record.modelId!, version.id, name),
        await retryInfo(record, child, library, intents)));
    }
  }

  const deleted = entry === null || record.children.some((child) =>
    child.version && !entry.versions.some((version) => version.id === child.version!.id));

  return parseStudio3d.run({
    libraryId: library.libraryId,
    intentId: record.intentId,
    deleted,
    checkJobId: record.operation === 'rig-check' ? record.intentId : null,
    model: !deleted && entry ? summarizeModel(entry.model, entry.versions, fileUrl) : null,
    versions: deleted ? [] : versions
  });
}

/**
 * Сведения о child адресуются стабильным childId, даже без version у rig-check.
 * Кандидат из history остаётся кандидатом до отдельного явного reconcile.
 */
export async function jobProjection(record: IntentRecord, library: StudioLibrary,
  intents: StudioIntents): Promise<Studio3dJob> {
  let deleted = false;
  let existingVersions: string[] = [];

  if (record.modelId) {
    try {
      existingVersions = (await library.readModel(record.modelId)).versions.map((version) => version.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      deleted = true;
    }
  }

  const children = [];

  for (const child of record.children) {
    const retry = await retryInfo(record, child, library, intents);

    children.push({
      childId: child.childId,
      versionId: deleted || !existingVersions.includes(child.version?.id ?? '')
        ? null : child.version?.id ?? null,
      operation: child.operation,
      provider: record.provider,
      status: child.status,
      waitReason: child.waitReason,
      estimated: child.estimated,
      actual: child.actual,
      unit: record.unit,
      paymentState: child.paymentState,
      taskId: child.taskId,
      candidates: child.candidates,
      retryAvailable: retry.available,
      retryReason: retry.reason,
      error: publicJobError(child),
    });
  }

  return parseStudio3d.job({
    intentId: record.intentId,
    libraryId: record.libraryId,
    deleted,
    modelId: deleted ? null : record.modelId,
    children,
    updatedAt: record.updatedAt
  });
}

/**
 * Таблица задач строится из durable журнала, включая удалённые проекции.
 * Финансовый исход не пропадает вместе с папкой модели.
 */
export async function taskProjection(record: IntentRecord, child: IntentChild,
  library: StudioLibrary, intents: StudioIntents): Promise<Studio3dTaskRow> {
  const job = await jobProjection(record, library, intents);
  const item = job.children.find((entry) => entry.childId === child.childId)!;

  return {
    intentId: record.intentId,
    childId: child.childId,
    modelId: job.modelId,
    modelName: job.deleted ? null : record.model?.name ?? null,
    versionId: item.versionId,
    label: child.plan?.label ?? child.operation,
    provider: record.provider,
    status: child.status,
    progress: child.progress,
    etaSeconds: child.etaSeconds,
    estimated: child.estimated,
    actual: child.actual,
    paymentState: child.paymentState,
    unit: record.unit,
    waitReason: child.waitReason,
    retryAvailable: item.retryAvailable,
    retryReason: item.retryReason,
    error: item.error,
    updatedAt: child.updatedAt
  };
}
