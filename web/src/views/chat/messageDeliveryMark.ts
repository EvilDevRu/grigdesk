import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);


// Метка доставки описывает обычную реплику человека без привязки к состоянию компонента.
// Неподтверждённая отправка важнее очереди, а уточнения сохраняют свой отдельный lifecycle.
export type MessageDeliveryMark =
  | {
    kind: 'pending';
    label: string;
    icon: 'clock' | 'offline'
  }
  | {
    kind: 'failed';
    label: string
  };

/**
 * Ожидание показывается значком у времени (часики или «нет связи»), сбой — значком у
 * пузыря, по которому повторяют отправку. Принятые реплики и уточнения метки не получают.
 */
export function messageDeliveryMark(
  message: {
    role?: string;
    kind?: string;
    queued?: boolean;
    delivery?: string
  },
  deliveryState?: string,
): MessageDeliveryMark | null {
  if (message.role !== 'user' || message.kind === 'in-turn') {
    return null;
  }
  if (message.delivery === 'sending') {
    if (deliveryState === 'retrying') {
      return {
        kind: 'pending',
        label: t('core.chatNetSvyaziSServerom'),
        icon: 'offline',
      };
    }
    if (deliveryState === 'lost') {
      return {
        kind: 'failed',
        label: t('core.chatNeDostavlenoServerNe'),
      };
    }

    return {
      kind: 'pending',
      label: deliveryState === 'posting' ? t('core.chatOtpravlyaetsya') : t('core.chatProveryayuDostavku'),
      icon: 'clock',
    };
  }
  if (message.queued) {
    return {
      kind: 'pending',
      label: t('core.chatZhdetOcherediUydetKogda'),
      icon: 'clock',
    };
  }

  return null;
}
