// Каналы доставки: что раздел умеет отправить сегодня и чего ему для этого не хватает.
//
// Ядро доставки (план, решение, этапы, неизвестный исход) готово и проверено. Здесь
// живёт другая часть — подключение к конкретным каналам, и она НЕ притворяется
// готовой:
//
//  • Битрикс24: файл на диск портала кокпит загружать умеет, а прикрепить его
//    комментарием к задаче — нет: такого запроса в клиенте портала пока не
//    существует. Загрузить и не прикрепить хуже, чем не начинать: файл повиснет
//    на диске, а человек будет считать, что отправил.
//  • Telegram: текущий клиент шлёт боту JSON, а файл требует multipart с лимитом
//    размера, таймаутом, отменой и вычисткой токена из текстов ошибок. Публиковать
//    ролик по открытой ссылке ради обхода — не вариант.
//
// Поэтому каждый канал объявляет готовность сам, а раздел показывает причину
// словами. Появится контракт — появится и отправка, без правки ядра.
import { ShowcaseError } from './errors.ts';
import type { DeliveryChannel, DeliveryPlan, DeliverySender } from './delivery.ts';

export interface ChannelStatus {
  id: DeliveryChannel;
  name: string;
  ready: boolean;
  reason: string;
  // Чего именно не хватает. Это не задача человеку, а объяснение: канал появится,
  // когда появится названный контракт.
  missing: string;
}

export interface DeliveryChannelDeps {
  // Клиент портала приходит извне: сессией владеет сервер, и раздел не заводит
  // вторую. Отсутствие клиента — обычное состояние установки без портала.
  b24?: { uploadDiskFile?: (source: unknown) => Promise<{ id: string }> } | null;
  telegramConnected?: () => boolean;
}

export function deliveryChannelStatuses(deps: DeliveryChannelDeps): ChannelStatus[] {
  const b24Ready = typeof deps.b24?.uploadDiskFile === 'function';

  return [
    {
      id: 'b24',
      name: 'Битрикс24',
      ready: false,
      reason: b24Ready
        ? 'Файл загрузить можно, но прикрепить его к задаче пока нечем.'
        : 'Портал не подключён.',
      missing: 'запрос прикрепления файла к задаче, проверенный на живом портале',
    },
    {
      id: 'telegram',
      name: 'Telegram',
      ready: false,
      reason: deps.telegramConnected?.()
        ? 'Аккаунт подключён, но бинарная отправка ещё не реализована.'
        : 'Аккаунт Telegram не подключён.',
      missing: 'multipart-отправка файла с лимитом, таймаутом и отменой',
    },
  ];
}

/**
 * Исполнитель отправки для канала. Пока ни один канал не готов, поэтому вызов даёт
 * отказ с точной причиной — вместо наполовину выполненной отправки, после которой
 * непонятно, дошло что-нибудь или нет.
 */
export function senderFor(channel: DeliveryChannel, deps: DeliveryChannelDeps): DeliverySender {
  const status = deliveryChannelStatuses(deps).find((item) => item.id === channel);

  return {
    upload: async (_attachment, plan: DeliveryPlan) => {
      throw new ShowcaseError(
        'channel_not_ready',
        `${status?.name ?? plan.channel}: ${status?.reason ?? 'канал не подключён'} `
        + `Нужен ${status?.missing ?? 'контракт отправки'}.`,
        503,
      );
    },
    attach: async () => {
      throw new ShowcaseError(
        'channel_not_ready',
        `${status?.name ?? channel}: ${status?.reason ?? 'канал не подключён'}`,
        503,
      );
    },
  };
}
