import { copyInstallFile } from '../../shared/node/binaryInstall.ts';

export { removePrivateTree as removeInstallStage } from '../../shared/node/files.ts';

/**
 * Адаптер сохраняет сообщения об ошибках и формат candidate своего потребителя.
 * Копированием обычного fd, закрытием и fsync владеет общий install core.
 */
export async function copyInstallCandidate(source: string, target: string): Promise<void> {
  const messages = {
    source: 'Candidate DeepSeek должен быть непустым обычным файлом',
    read: 'Копирование candidate DeepSeek оборвалось',
    write: 'Запись candidate DeepSeek оборвалась',
  };

  await copyInstallFile(source, target, {
    failure: (phase) => new Error(messages[phase]),
  });
}
