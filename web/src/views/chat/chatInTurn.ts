import { IN_TURN_PROTOCOL, IN_TURN_TEXT_LIMIT_BYTES, utf8Bytes }
  from '../../../../shared/chatInTurnContracts.ts';
import type {
  InTurnCapability,
  InTurnDeliveryState,
  InTurnUnavailableReason,
} from '../../../../shared/chatInTurnContracts.ts';
import type { ChatInTurnRun } from '../../stores/chatInTurn.ts';

const REASONS: Record<InTurnUnavailableReason, string> = {
  not_ready: 'Канал уточнений ещё не готов.',
  unsupported: 'Этот исполнитель не принимает уточнения во время хода.',
  compacting: 'Дождись окончания сжатия контекста.',
  workdir_transition: 'Дождись смены рабочей папки.',
  chat_busy: 'Чат занят другим действием.',
  awaiting_answer: 'Сначала ответь на вопрос агента.',
};

interface ComposerState {
  active: boolean;
  ready: boolean;
  reason: string;
}

function composerState(active: boolean, ready: boolean, reason: string): ComposerState {
  return {
    active,
    ready,
    reason,
  };
}

/**
 * Выбор действия композера зависит от подтверждённого активного run и capability.
 * Причину отказа возвращаем словами, чтобы окно могло показать её рядом с кнопкой.
 */
export function inTurnComposerState({ run, protocol, capability, pendingCount, text }: {
  run: ChatInTurnRun | null;
  protocol: number;
  capability: InTurnCapability | null | undefined;
  pendingCount: number;
  text: string;
}): ComposerState {
  if (!run?.active || !run.runId) {
    return composerState(false, false, '');
  }

  if (protocol !== IN_TURN_PROTOCOL) {
    return composerState(true, false, 'Сервер не поддерживает уточнения во время хода.');
  }
  if (capability?.protocol !== IN_TURN_PROTOCOL || capability.text !== true) {
    return composerState(true, false, REASONS.unsupported);
  }
  if (pendingCount) {
    return composerState(true, false, 'Уточнение принимает только текст. Вложения можно отправить следом.');
  }
  if (utf8Bytes(text || '') > IN_TURN_TEXT_LIMIT_BYTES) {
    return composerState(true, false, 'Уточнение длиннее 32 КиБ.');
  }
  if (!run.availability?.available) {
    const reason = run.availability?.reason || 'not_ready';

    return composerState(true, false, REASONS[reason]);
  }

  return composerState(true, true, '');
}

/**
 * Статус транспорта виден человеку отдельно от приёма сервером.
 * Неопределённый исход предупреждает о возможном дубле при ручном повторе.
 */
export function inTurnDeliveryText(state: InTurnDeliveryState | undefined, error = ''): string {
  switch (state) {
    case 'accepted': return 'Принято, ожидает передачи';
    case 'delivering': return 'Передаётся агенту';
    case 'forwarded': return 'Передано агенту';
    case 'consumed': return 'Включено в контекст';
    case 'failed': return error || 'Не передано агенту';
    case 'unknown': return error || 'Исход передачи неизвестен. Проверь ответ агента перед повтором.';
    default: return 'Ожидает подтверждения';
  }
}
