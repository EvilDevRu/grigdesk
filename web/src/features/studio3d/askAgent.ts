import type { Studio3dModelDetail, Studio3dVersion } from '../../../../shared/studio3d/studio3dContracts.ts';
import { api } from '../../shared/apiClient.ts';
import { statsText } from './presentation.ts';

interface ChatPort {
  defModelRef: unknown;
  newSession(options: {
    workdir: { kind: 'path'; path: string };
    title: string;
    draft: string
  }): unknown;
}

/**
 * Путь берётся из серверной папки модели и зарегистрированного имени файла версии.
 * Incoming находится в той же рабочей папке, а проект обозначает только контекст.
 */
export function askAgentDraft(detail: Studio3dModelDetail, version: Studio3dVersion): string {
  const file = version.files.find((item) => item.id === version.mainFileId);

  if (!file) {
    throw new Error('У версии нет локального основного файла. Сначала скачайте её.');
  }

  return `Модель «${detail.model.name}», версия «${version.label}».\n`
    + `Файл: ${detail.modelDirectory}/${version.id}/${file.name}\n`
    + `${statsText(version.stats)}.\n`
    + (detail.model.project ? `Проект: ${detail.model.project}.\n` : '')
    + `Результат положи в ${detail.modelDirectory}/incoming/ — GrigDesk предложит добавить его версией.`;
}

/**
 * До создания разговора штатный resolver проверяет папку и capability выбранного исполнителя.
 * Черновик не отправляется сам; библиотека вне GrigDesk не наследует чужой default cwd.
 */
export async function askStudioAgent(detail: Studio3dModelDetail, version: Studio3dVersion,
  chat: ChatPort, router: { push(path: string): Promise<unknown> },
  preview: (body: unknown) => Promise<unknown> = (body) => api.post('/api/chat/workdir/preview', body)
): Promise<void> {
  const draft = askAgentDraft(detail, version);
  const workdir = { kind: 'path' as const, path: detail.modelDirectory };
  const result = await preview({ modelRef: chat.defModelRef, candidate: { taskId: null, workdir } });
  const checked = result as { capability?: unknown; target?: { cwd?: string } };

  if (!checked?.capability || checked.target?.cwd !== detail.modelDirectory) {
    throw new Error('Выбранный исполнитель не поддерживает рабочую папку этой модели.');
  }

  chat.newSession({
    workdir,
    title: `3D · ${detail.model.name}`,
    draft
  });
  await router.push('/chats');
}
