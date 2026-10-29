import { normalizeChatWorkdir } from '../../../shared/chat/chatWorkdir.ts';
import type { ChatWorkdir } from '../../../shared/chat/chatWorkdir.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { api, failureText } from './apiClient.ts';
import { t } from '../ui.ts';

export interface AskAgentInput {
  workdir: ChatWorkdir;
  title: string;
  draft: string;
}

export interface AskAgentOptions {
  chat: {
    defModelRef: unknown;
    ensure(): Promise<unknown>;
    newSession(input: AskAgentInput): string | null;
  };
  router: {
    push(location: { path: string; query: Record<string, string> }): unknown;
  };
  signal: AbortSignal;
  isAlive: () => boolean;
  preview?: (body: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
}

/**
 * Чат создаётся лишь после серверного предпросмотра папки выбранной модели.
 * Загружаем историю до создания черновика, чтобы поздний store не затёр новую сессию.
 */
export async function askAgent(input: AskAgentInput, options: AskAgentOptions): Promise<string> {
  const { chat, router, signal, isAlive } = options;
  const checkAlive = () => {
    if (signal.aborted || !isAlive()) {
      throw new Error(t('core.pluginModuleAccessRevoked'));
    }
  };

  checkAlive();

  const workdir = isRecord(input) && Object.hasOwn(input, 'workdir') && input.workdir !== undefined
    ? normalizeChatWorkdir(input.workdir) : null;

  if (!workdir || typeof input.title !== 'string' || !input.title.trim()
    || typeof input.draft !== 'string') {
    throw new Error(t('core.pluginAskAgentInvalidInput'));
  }

  await chat.ensure();
  checkAlive();

  if (!isRecord(chat.defModelRef) || typeof chat.defModelRef.provider !== 'string'
    || !chat.defModelRef.provider || typeof chat.defModelRef.model !== 'string' || !chat.defModelRef.model) {
    throw new Error(t('core.pluginAskAgentChooseModel'));
  }

  const modelRef = {
    provider: chat.defModelRef.provider,
    model: chat.defModelRef.model,
  };
  const preview = options.preview ?? ((body, init) => api.post('/api/chat/workdir/preview', body, init));
  let reply: unknown;

  try {
    reply = await preview({ modelRef, candidate: { taskId: null, workdir } }, { signal });
  } catch (error) {
    throw new Error(failureText(error, t('core.pluginAskAgentPreviewFailed')));
  }

  checkAlive();

  const capability = isRecord(reply) ? reply.capability : null;
  const target = isRecord(reply) ? reply.target : null;
  const confirmed = isRecord(target) && Object.hasOwn(target, 'workdir') && target.workdir !== undefined
    ? normalizeChatWorkdir(target.workdir) : null;

  if (!isRecord(capability) || !['resume', 'reseed'].includes(String(capability.switch))
    || !['single', 'multi'].includes(String(capability.roots))) {
    throw new Error(t('core.pluginAskAgentUnsupported'));
  }
  if (!isRecord(target) || typeof target.cwd !== 'string' || !target.cwd.startsWith('/')
    || !confirmed) {
    throw new Error(t('core.pluginAskAgentPreviewFailed'));
  }
  if (!isRecord(chat.defModelRef) || chat.defModelRef.provider !== modelRef.provider
    || chat.defModelRef.model !== modelRef.model) {
    throw new Error(t('core.pluginAskAgentModelChanged'));
  }

  const id = chat.newSession({
    workdir: confirmed.kind === 'path' ? { kind: 'path', path: target.cwd } : confirmed,
    title: input.title,
    draft: input.draft,
  });

  if (!id) {
    throw new Error(t('core.chatStoreNotLoaded'));
  }

  await router.push({ path: '/chats', query: { openChat: id } });

  return id;
}
