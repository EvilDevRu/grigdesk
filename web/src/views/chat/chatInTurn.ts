import {
  IN_TURN_ATTACHMENT_LIMIT,
  IN_TURN_PROTOCOL,
  IN_TURN_TEXT_LIMIT_BYTES,
  utf8Bytes,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import type {
  InTurnCapability,
  InTurnDeliveryState,
  InTurnUnavailableReason,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import type { ChatInTurnRun } from '../../stores/chatInTurn.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


const REASONS: Record<InTurnUnavailableReason, string> = {
  get not_ready() {
    return translateUi('core.chatInTurnTheInTurnMessageChannelIsNot');
  },
  get unsupported() {
    return translateUi('core.chatInTurnThisExecutorDoesNotAcceptMessagesDuring');
  },
  get compacting() {
    return translateUi('core.chatInTurnWaitForContextCompactionToFinish');
  },
  get workdir_transition() {
    return translateUi('core.chatInTurnWaitForTheWorkingFolderToChange');
  },
  get chat_busy() {
    return translateUi('core.chatInTurnTheChatIsBusyWithAnotherAction');
  },
  get awaiting_answer() {
    return translateUi('core.chatInTurnAnswerTheAgentSQuestionFirst');
  },
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
    return translateUi('core.chatInTurnAttachmentsCannotBeSentDuringTheCurrent');
  }
  if (!pendingImages) {
    return translateUi('core.chatInTurnOnlyImagesCanBeSentDuringThe');
  }
  if (pendingCount > IN_TURN_ATTACHMENT_LIMIT) {
    return translateUi(
      'core.chatInTurnAnInTurnMessageCanContainAt',
      { IN_TURN_ATTACHMENT_LIMIT: IN_TURN_ATTACHMENT_LIMIT },
    );
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
    return composerState(true, false, translateUi('core.chatInTurnTheServerDoesNotSupportInTurn'));
  }
  if (capability?.protocol !== IN_TURN_PROTOCOL || capability.text !== true) {
    return composerState(true, false, REASONS.unsupported);
  }

  const attachments = attachmentsReason(capability, pendingCount, pendingImages);

  if (attachments) {
    return composerState(true, false, attachments);
  }
  if (utf8Bytes(text || '') > IN_TURN_TEXT_LIMIT_BYTES) {
    return composerState(true, false, translateUi('core.chatInTurnTheInTurnMessageExceeds32KiB'));
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
    case 'accepted': return translateUi('core.chatInTurnAcceptedAwaitingDelivery');
    case 'delivering': return translateUi('core.chatInTurnSendingToTheAgent');
    case 'forwarded': return translateUi('core.chatInTurnDeliveredToTheAgent');
    case 'consumed': return translateUi('core.chatInTurnIncludedInContext');
    case 'failed': return error || translateUi('core.chatInTurnNotDeliveredToTheAgent');
    case 'unknown': return error || translateUi('core.chatInTurnTheDeliveryOutcomeIsUnknownCheckThe');
    default: return translateUi('core.chatInTurnAwaitingConfirmation');
  }
}
