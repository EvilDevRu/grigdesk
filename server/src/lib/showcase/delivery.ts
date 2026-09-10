// Доставка готового ролика получателю.
//
// Это внешний эффект, и он необратим: отправленное нельзя «отменить». Отсюда весь
// строй модуля.
//
//  • Отправляется ТОЛЬКО актуальный принятый финал. Ролик, собранный из прошлой
//    редакции, получателю уходить не должен — он выглядит готовым и врёт.
//  • Решение человека одноразовое и привязано к точным байтам: смена финала,
//    получателя или канала делает его недействительным. Двойной клик возвращает
//    ту же отправку, а не заводит вторую.
//  • Неизвестный исход — отдельное состояние, а не «ошибка». Потеря ответа после
//    отправки НЕ означает, что получатель ничего не получил, поэтому автоматического
//    повтора нет: сверку и решение делает человек.
import { createHash, randomBytes } from 'node:crypto';

import { ShowcaseError } from './errors.ts';
import type { ShowcaseArtifactRef, ShowcaseProject } from '../../../../shared/showcaseContracts.ts';

export type DeliveryChannel = 'b24' | 'telegram';

export type DeliveryState =
  | 'prepared'
  | 'sending'
  | 'uploaded'
  | 'sent'
  | 'failed'
  | 'outcome_unknown';

export interface DeliveryAttachment {
  artifactId: string;
  name: string;
  mediaType: string;
  byteSize: number;
  // Хеш содержимого нужен решению: подтверждали именно эти байты, а не «последний
  // собранный файл» — он мог смениться между показом и нажатием.
  contentHash: string;
}

export interface DeliveryPlan {
  channel: DeliveryChannel;
  recipient: string;
  recipientLabel: string;
  attachments: DeliveryAttachment[];
  caption: string;
  warnings: string[];
  // Отпечаток плана: канал, получатель и точные байты вложений. Решение выдаётся
  // на него и на нём же проверяется.
  fingerprint: string;
}

export interface DeliveryRecord {
  id: string;
  channel: DeliveryChannel;
  recipient: string;
  fingerprint: string;
  state: DeliveryState;
  reason: string;
  // Идентификаторы, выданные каналом по этапам: по ним человек находит уже
  // загруженный файл и не грузит его второй раз.
  stageIds: Record<string, string>;
  startedAt: string;
  finishedAt: string | null;
}

export interface ChannelLimits {
  maxBytes: number;
  label: string;
}

// Пределы каналов известны заранее и проверяются ДО подтверждения: узнать про
// лимит из провалившейся отправки — значит потратить время человека впустую.
export const CHANNEL_LIMITS: Record<DeliveryChannel, ChannelLimits> = {
  b24: { maxBytes: 1024 * 1024 * 1024, label: 'Битрикс24' },
  telegram: { maxBytes: 50 * 1024 * 1024, label: 'Telegram' },
};

function fingerprintOf(input: {
  channel: DeliveryChannel;
  recipient: string;
  attachments: DeliveryAttachment[];
}): string {
  const parts = input.attachments.map((item) => `${item.artifactId}:${item.contentHash}`).sort();

  return createHash('sha256')
    .update(`${input.channel}\n${input.recipient}\n${parts.join('\n')}`)
    .digest('hex')
    .slice(0, 32);
}

export interface PreparePlanInput {
  project: ShowcaseProject;
  channel: DeliveryChannel;
  recipient: string;
  recipientLabel: string;
  includeSubtitles: boolean;
}

/**
 * Готовит план отправки. Здесь ничего не уходит наружу — план нужен, чтобы человек
 * увидел ровно то, что подтверждает: канал, получателя, файлы, их размер и
 * предупреждения канала.
 */
export function prepareDeliveryPlan(input: PreparePlanInput): DeliveryPlan {
  const final = input.project.latestFinal;

  if (!final) {
    throw new ShowcaseError('no_final', 'Ролик ещё не собран: отправлять нечего.', 409);
  }

  if (!final.current) {
    throw new ShowcaseError(
      'final_stale',
      'Последняя сборка устарела: отправлять можно только актуальный ролик.',
      409,
    );
  }

  const attachments: DeliveryAttachment[] = [attachmentOf(final.video, 'showcase.mp4', 'video/mp4')];

  if (input.includeSubtitles && final.subtitles) {
    attachments.push(attachmentOf(final.subtitles, 'showcase.srt', 'application/x-subrip'));
  }

  const limits = CHANNEL_LIMITS[input.channel];
  const warnings: string[] = [];
  const oversized = attachments.filter((item) => item.byteSize > limits.maxBytes);

  for (const item of oversized) {
    warnings.push(
      `Файл ${item.name} (${Math.round(item.byteSize / 1024 / 1024)} МБ) больше предела `
      + `канала ${limits.label} (${Math.round(limits.maxBytes / 1024 / 1024)} МБ).`,
    );
  }

  return {
    channel: input.channel,
    recipient: input.recipient,
    recipientLabel: input.recipientLabel,
    attachments,
    caption: input.project.title,
    warnings,
    fingerprint: fingerprintOf({
      channel: input.channel,
      recipient: input.recipient,
      attachments,
    }),
  };
}

function attachmentOf(
  artifact: ShowcaseArtifactRef,
  name: string,
  mediaType: string,
): DeliveryAttachment {
  return {
    artifactId: artifact.id,
    name,
    mediaType,
    byteSize: artifact.byteSize,
    contentHash: artifact.contentHash,
  };
}

export interface DeliverySender {
  // Этапы разделены намеренно: загруженный файл и прикреплённый к задаче — разные
  // события, и после обрыва между ними повторно грузить файл незачем.
  upload(attachment: DeliveryAttachment, plan: DeliveryPlan): Promise<string>;
  attach(fileIds: string[], plan: DeliveryPlan): Promise<string>;
}

export interface RunDeliveryInput {
  plan: DeliveryPlan;
  decisionFingerprint: string;
  sender: DeliverySender;
  // Уже выполненные отправки этого ролика: по ним двойной клик возвращает прежний
  // результат вместо второй отправки тех же байтов тому же получателю.
  existing: DeliveryRecord[];
}

/**
 * Выполняет доставку по подтверждённому плану. Возвращает запись журнала — она же
 * ответ человеку: по ней видно, на каком этапе всё остановилось и что с этим делать.
 */
export async function runDelivery(input: RunDeliveryInput): Promise<DeliveryRecord> {
  if (input.decisionFingerprint !== input.plan.fingerprint) {
    throw new ShowcaseError(
      'delivery_decision_stale',
      'Ролик, получатель или канал изменились после подтверждения: нужно решение на новую отправку.',
      409,
    );
  }

  if (input.plan.warnings.length > 0) {
    throw new ShowcaseError('delivery_blocked', input.plan.warnings.join(' '), 409);
  }

  const done = input.existing.find((item) => (
    item.fingerprint === input.plan.fingerprint
    && (item.state === 'sent' || item.state === 'sending' || item.state === 'outcome_unknown')
  ));

  if (done) {
    return done;
  }

  const record: DeliveryRecord = {
    id: randomBytes(6).toString('hex'),
    channel: input.plan.channel,
    recipient: input.plan.recipient,
    fingerprint: input.plan.fingerprint,
    state: 'sending',
    reason: '',
    stageIds: {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const fileIds: string[] = [];

  for (const attachment of input.plan.attachments) {
    try {
      const fileId = await input.sender.upload(attachment, input.plan);

      record.stageIds[attachment.artifactId] = fileId;
      fileIds.push(fileId);
    } catch (error) {
      return {
        ...record,
        state: unknownOutcome(error) ? 'outcome_unknown' : 'failed',
        reason: unknownOutcome(error)
          ? `Ответ по загрузке ${attachment.name} потерян: проверьте получателя вручную.`
          : `Загрузка ${attachment.name} не удалась: ${messageOf(error)}`,
        finishedAt: new Date().toISOString(),
      };
    }
  }

  try {
    const outcome = await input.sender.attach(fileIds, input.plan);

    return {
      ...record,
      state: 'sent',
      reason: 'Отправлено.',
      stageIds: { ...record.stageIds, delivery: outcome },
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    // Файлы уже загружены: их идентификаторы остаются в журнале, чтобы повтор не
    // грузил те же байты заново.
    return {
      ...record,
      state: unknownOutcome(error) ? 'outcome_unknown' : 'failed',
      reason: unknownOutcome(error)
        ? 'Ответ по отправке потерян: получатель мог её уже получить, проверьте вручную.'
        : `Отправка не удалась: ${messageOf(error)}`,
      finishedAt: new Date().toISOString(),
    };
  }
}

/**
 * Потеря ответа отличается от отказа. Таймаут и обрыв соединения означают «неизвестно»:
 * запрос мог дойти целиком, и повторять его самим нельзя.
 */
function unknownOutcome(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? '';
  const name = (error as { name?: string })?.name ?? '';

  return code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'UND_ERR_HEADERS_TIMEOUT'
    || name === 'TimeoutError'
    || name === 'AbortError';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
