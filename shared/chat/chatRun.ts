// Снимок конкретного исполнения отделён от выбора следующего хода и истории.
// Подтверждение модели относится к ответу либо к сессии; запрошенный id фактом не становится.
export type ChatModelSource = 'session' | 'response';

// Эффективный профиль прав текущего хода: сериализуемое описание, а не допуск.
// confirmed=true приходит только после readback живого runtime; старое событие
// без поля или с повреждённой структурой не создаёт подтверждённых прав.
export interface ChatRunPermissionProfile {
  id: string;
  sandbox: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  confirmed: boolean;
}

export interface ChatRunMetadata {
  actualModelId?: string;
  modelSource?: ChatModelSource;
  permissionProfile?: ChatRunPermissionProfile;
}

export interface ChatRunSnapshot {
  chatKey: string;
  runId: string;
  turnId?: string;
  providerId: string;
  requestedModelId: string;
  permissionMode?: string;
  permissionProfile?: ChatRunPermissionProfile;
  actualModelId?: string;
  modelSource?: ChatModelSource;
  cwd: string;
  extraDirs: string[];
}

/**
 * Профиль принимается только полной валидной структурой с точным boolean confirmed.
 * Строки, числа и пустой id не превращаются в факт подтверждённых прав.
 */
export function normalizeChatRunPermissionProfile(value: unknown): ChatRunPermissionProfile | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const strings = ['id', 'sandbox', 'approvalPolicy', 'approvalsReviewer'] as const;

  if (strings.some((key) => typeof raw[key] !== 'string' || !raw[key])
    || typeof raw.confirmed !== 'boolean') {
    return undefined;
  }

  return {
    id: raw.id as string,
    sandbox: raw.sandbox as string,
    approvalPolicy: raw.approvalPolicy as string,
    approvalsReviewer: raw.approvalsReviewer as string,
    confirmed: raw.confirmed,
  };
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
  const permissionProfile = normalizeChatRunPermissionProfile(raw.permissionProfile);

  return {
    chatKey: raw.chatKey as string,
    runId: raw.runId as string,
    ...(typeof raw.turnId === 'string' && raw.turnId ? { turnId: raw.turnId } : {}),
    providerId: raw.providerId as string,
    requestedModelId: raw.requestedModelId as string,
    ...(typeof raw.permissionMode === 'string' ? { permissionMode: raw.permissionMode } : {}),
    ...(permissionProfile ? { permissionProfile } : {}),
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
