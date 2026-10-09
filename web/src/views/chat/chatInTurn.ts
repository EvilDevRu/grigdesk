import {
  IN_TURN_ATTACHMENT_LIMIT,
  IN_TURN_PROTOCOL,
  IN_TURN_TEXT_LIMIT_BYTES,
  utf8Bytes,
} from '../../../../shared/chatInTurnContracts.ts';
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
 * Почему вложения черновика не могут уйти в текущий ход. Пустая строка — могут:
 * исполнитель объявил картинки, все вложения картинки и их не больше предела.
 */
function attachmentsReason(
  capability: InTurnCapability | null | undefined,
  pendingCount: number,
  pendingImages: boolean,
): string {
  if (!pendingCount) {
    return '';
  }
  if (capability?.images !== true) {
    return 'Вложения нельзя передать в текущий ход.';
  }
  if (!pendingImages) {
    return 'В текущий ход передаются только картинки.';
  }
  if (pendingCount > IN_TURN_ATTACHMENT_LIMIT) {
    return `В одном уточнении не больше ${IN_TURN_ATTACHMENT_LIMIT} картинок.`;
  }

  return '';
}

/**
 * Выбор действия композера зависит от подтверждённого активного run и capability.
 * Причину отказа возвращаем словами, чтобы окно могло показать её рядом с кнопкой.
 * `pendingImages` подтверждает, что все вложения черновика — картинки.
 */
export function inTurnComposerState({
  run,
  protocol,
  capability,
  pendingCount,
  pendingImages = false,
  text,
}: {
  run: ChatInTurnRun | null;
  protocol: number;
  capability: InTurnCapability | null | undefined;
  pendingCount: number;
  pendingImages?: boolean;
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

  const attachments = attachmentsReason(capability, pendingCount, pendingImages);

  if (attachments) {
    return composerState(true, false, attachments);
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
