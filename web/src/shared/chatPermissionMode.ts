import { isChatModeSelection } from '../../../shared/chat/chatPermissionModes.ts';
import type { ChatModeSelection } from '../../../shared/chat/chatPermissionModes.ts';
import type { ProviderEntry } from '../../../shared/chat/providersContracts.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);

interface PermissionMode {
  id: string;
  requiresExplicitSelection?: boolean;
}

type Policy = Pick<ProviderEntry,
  'id' | 'defaultPermissionMode' | 'permissionModeSelectionPolicy'
  | 'permissionModesRequiringExplicitSelection'>;

/**
 * Один resolver определяет и показанный режим, и право отправки во всех send-путях.
 * Исчезновение явного выбора блокирует отправку, сохраняя намерение пользователя.
 */
export function resolvePermissionMode(value: unknown, modes: readonly PermissionMode[],
  policy?: Partial<Policy>, selection?: unknown, chatId?: string) {
  const explicit = typeof value === 'string' && value.length > 0;
  const descriptor = modes.find((entry) => entry.id === value);
  const validSelection = isChatModeSelection(selection) && selection.provider === policy?.id
    && selection.id === value && selection.chatId === chatId && selection.revision === 1;
  const requiresExplicit = descriptor?.requiresExplicitSelection
    || (typeof value === 'string' && policy?.permissionModesRequiringExplicitSelection?.includes(value));
  const legacyUnsafe = requiresExplicit && !validSelection;
  const mode = explicit && !legacyUnsafe
    && (descriptor || policy?.permissionModeSelectionPolicy === 'preserve-explicit')
    ? value
    : policy?.defaultPermissionMode
      || (modes.some((entry) => entry.id === 'manual') ? 'manual' : modes[0]?.id || '');

  return {
    mode: String(mode),
    available: modes.some((entry) => entry.id === mode),
    modeSelection: validSelection && !legacyUnsafe ? selection as ChatModeSelection : undefined
  };
}

/**
 * Меню и запрос должны выбирать один режим из списка текущего исполнителя.
 * Сохранённый ID другого провайдера не должен незаметно уехать в HTTP body.
 */
export function effectivePermissionMode(value: unknown, modes: readonly PermissionMode[],
  policy?: Partial<Policy>, selection?: unknown, chatId?: string): string {
  return resolvePermissionMode(value, modes, policy, selection, chatId).mode;
}

/**
 * Запрос фиксирует mode вместе с selection до первого await сохранения.
 * Необъявленные режимы legacy providers сохраняют прежний пустой wire-контракт.
 */
export function permissionModeRequest(chat: {
  id: string;
  mode?: string;
  modeSelection?: unknown
},
  provider: Policy & Pick<ProviderEntry, 'modes'>) {
  const result = resolvePermissionMode(chat.mode, provider.modes || [], provider,
    chat.modeSelection, chat.id);

  if (!result.available && (provider.defaultPermissionMode
    || provider.permissionModeSelectionPolicy === 'preserve-explicit')) {
    throw new Error(t('core.chatModeUnavailableSend'));
  }

  return { mode: result.mode,
    ...(result.modeSelection ? { modeSelection: { ...result.modeSelection } } : {}) };
}
