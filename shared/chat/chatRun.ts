// Снимок конкретного исполнения отделён от выбора следующего хода и истории.
// Подтверждение модели относится к ответу либо к сессии; запрошенный id фактом не становится.
export type ChatModelSource = 'session' | 'response';

export interface ChatRunMetadata {
  actualModelId: string;
  modelSource: ChatModelSource;
}

export interface ChatRunSnapshot {
  chatKey: string;
  runId: string;
  turnId?: string;
  providerId: string;
  requestedModelId: string;
  permissionMode?: string;
  actualModelId?: string;
  modelSource?: ChatModelSource;
  cwd: string;
  extraDirs: string[];
}

/**
 * Старый сервер и неполные события не создают фиктивный снимок запуска.
 * Факт модели принимается только вместе с известным источником подтверждения.
 */
export function normalizeChatRunSnapshot(value: unknown): ChatRunSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const required = ['chatKey', 'runId', 'providerId', 'requestedModelId', 'cwd'];

  if (required.some((key) => typeof raw[key] !== 'string' || !raw[key])) {
    return null;
  }

  const confirmed = typeof raw.actualModelId === 'string' && !!raw.actualModelId
    && (raw.modelSource === 'session' || raw.modelSource === 'response');

  return {
    chatKey: raw.chatKey as string,
    runId: raw.runId as string,
    ...(typeof raw.turnId === 'string' && raw.turnId ? { turnId: raw.turnId } : {}),
    providerId: raw.providerId as string,
    requestedModelId: raw.requestedModelId as string,
    ...(typeof raw.permissionMode === 'string' ? { permissionMode: raw.permissionMode } : {}),
    ...(confirmed ? {
      actualModelId: raw.actualModelId as string,
      modelSource: raw.modelSource as ChatModelSource,
    } : {}),
    cwd: raw.cwd as string,
    extraDirs: Array.isArray(raw.extraDirs)
      ? raw.extraDirs.filter((item): item is string => typeof item === 'string' && !!item)
      : [],
  };
}
