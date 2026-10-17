// Доставка готового ролика получателю.
//
// Отправка — внешний и необратимый эффект, поэтому она в два шага: сервер готовит
// ПЛАН с точными файлами, размерами и хешами, а человек подтверждает именно его.
// Подтверждение привязано к отпечатку плана: пересобранный ролик делает прежнее
// решение недействительным.
import { prepareDeliveryPlan, runDelivery } from './delivery.ts';
import type { DeliveryChannel, DeliveryRecord } from './delivery.ts';
import { deliveryChannelStatuses, senderFor } from './deliveryChannels.ts';
import type { DeliveryChannelDeps } from './deliveryChannels.ts';
import type { ShowcaseProject } from '../../../../shared/plugins/showcase/showcaseContracts.ts';

export interface DeliveryOpsDeps {
  assertEnabled: () => void;
  // Журнал доставок по ролику: он отвечает на вопрос «что и куда ушло», и уборка
  // тяжёлых артефактов его не касается.
  deliveries: Map<string, DeliveryRecord[]>;
  channelDeps: () => DeliveryChannelDeps;
  readProject: (id: string) => Promise<ShowcaseProject>;
}

export function createDeliveryOps(deps: DeliveryOpsDeps) {
  const { assertEnabled, deliveries, readProject } = deps;

  /**
   * Что раздел умеет отправить и чего ему не хватает. Отдаётся до подтверждения:
   * человек должен видеть отказ канала раньше, чем нажмёт «отправить».
   */
  function deliveryChannels() {
    assertEnabled();

    return { channels: deliveryChannelStatuses(deps.channelDeps()) };
  }

  /**
   * План отправки: канал, получатель и ТОЧНЫЕ байты. Ничего не уходит наружу —
   * это то, что человек подтверждает, и по его отпечатку решение потом проверяется.
   */
  async function planDelivery(id: string, input: {
    channel: DeliveryChannel;
    recipient: string;
    recipientLabel: string;
    includeSubtitles: boolean;
  }) {
    assertEnabled();

    const project = await readProject(id);

    return prepareDeliveryPlan({
      project,
      channel: input.channel,
      recipient: input.recipient,
      recipientLabel: input.recipientLabel,
      includeSubtitles: input.includeSubtitles,
    });
  }

  /**
   * Отправка по подтверждённому плану. Журнал доставки хранится отдельно от тяжёлых
   * байтов: он переживает уборку артефактов, потому что отвечает на вопрос «что и
   * куда ушло», а не «что лежит на диске».
   */
  async function deliver(id: string, input: {
    channel: DeliveryChannel;
    recipient: string;
    recipientLabel: string;
    includeSubtitles: boolean;
    decisionFingerprint: string;
  }): Promise<DeliveryRecord> {
    assertEnabled();

    const plan = await planDelivery(id, input);
    const record = await runDelivery({
      plan,
      decisionFingerprint: input.decisionFingerprint,
      sender: senderFor(input.channel, deps.channelDeps()),
      existing: deliveries.get(id) ?? [],
    });

    deliveries.set(id, [...(deliveries.get(id) ?? []).filter((item) => item.id !== record.id), record]);

    return record;
  }

  return { deliver, deliveryChannels, planDelivery };
}
