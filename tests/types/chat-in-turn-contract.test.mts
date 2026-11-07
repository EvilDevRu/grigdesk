// Типы контракта уточнений внутри хода.
//
// Проверяет компилятор: ослабление контракта (состояние строкой, потеря sequence или
// необязательный runId) обязано стать ошибкой, а не тихо доехать до окна.
import type {
  InTurnAssistantBlock,
  InTurnAvailability,
  InTurnDeliverResult,
  InTurnPort,
  InTurnReceipt,
} from '../../shared/chat/chatInTurnContracts.ts';
import { IN_TURN_BACKLOG_LIMIT, canTransition, utf8Bytes } from '../../shared/chat/chatInTurnContracts.ts';
import { ChatInTurnLedger } from '../../server/src/lib/chat/inTurnLedger.ts';
import { InTurnMessages } from '../../server/src/lib/chat/inTurnMessages.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type ReceiptIsChecked = Checked<IsUnchecked<InTurnReceipt>>;
export type BlockIsChecked = Checked<IsUnchecked<InTurnAssistantBlock>>;

/**
 * Примеры запускает только компилятор: состояние доставки — закрытое перечисление,
 * идентификаторы обязательны, а порт обязан вернуть типизированный исход.
 */
function checkContracts(
  input: unknown,
  receipt: InTurnReceipt,
  port: InTurnPort,
): void {
  // @ts-expect-error Непроверенный JSON не является записью о приёме.
  const unchecked: InTurnReceipt = input;
  // @ts-expect-error Состояние доставки ограничено объявленным перечислением.
  const state: InTurnReceipt['state'] = 'sent';
  // @ts-expect-error runId обязателен: уточнение всегда принадлежит конкретному запуску.
  const withoutRun: InTurnReceipt = { chatKey: 'c', messageId: 'm' };
  // @ts-expect-error sequence назначает сервер, а не окно.
  const withStringSequence: InTurnReceipt = { ...receipt, sequence: '1' };
  // @ts-expect-error Готовность канала без ревизии не бывает: позднее событие её не откатит.
  const availability: InTurnAvailability = { runId: 'r', available: true };
  // @ts-expect-error Порт обязан вернуть исход передачи, а не пустоту.
  const badPort: InTurnPort = { deliver: async () => undefined };

  const result: InTurnDeliverResult = { ok: false, code: 'x', message: 'y', uncertain: true };

  if (result.ok) {
    // @ts-expect-error У успешного исхода нет кода ошибки.
    result.code.toLowerCase();
  }
  if (canTransition('consumed', 'forwarded')) {
    throw new Error('unreachable');
  }

  void [
    unchecked,
    state,
    withoutRun,
    withStringSequence,
    availability,
    badPort,
    result,
    IN_TURN_BACKLOG_LIMIT,
    utf8Bytes('текст'),
    port,
    new ChatInTurnLedger({ dir: '/tmp/in-turn' }),
    InTurnMessages,
  ];
}

void checkContracts;
