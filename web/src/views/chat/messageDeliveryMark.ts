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
        label: 'Нет связи с сервером — повторяю отправку…',
        icon: 'offline',
      };
    }
    if (deliveryState === 'lost') {
      return {
        kind: 'failed',
        label: 'Не доставлено: сервер не подтвердил приём',
      };
    }

    return {
      kind: 'pending',
      label: deliveryState === 'posting' ? 'Отправляется' : 'Проверяю доставку',
      icon: 'clock',
    };
  }
  if (message.queued) {
    return {
      kind: 'pending',
      label: 'Ждёт очереди — уйдёт, когда агент закончит текущий ход',
      icon: 'clock',
    };
  }

  return null;
}
