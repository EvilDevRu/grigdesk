import type { FileHandle } from 'node:fs/promises';

import { copyInstallFile } from '../../../shared/node/binaryInstall.ts';

export { removePrivateTree as removeInstallStage } from '../../../shared/node/files.ts';

/**
 * ELF magic проверяется на открытом fd до копирования серверного candidate.
 * Общий copier не навязывает этот формат DeepSeek и другим потребителям.
 */
async function requireElf(input: FileHandle): Promise<void> {
  const magic = Buffer.alloc(4);

  await input.read(magic, 0, 4, 0);

  if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error('Candidate сервера должен быть ELF');
  }
}

/**
 * Адаптер сохраняет сообщения об ошибках и формат candidate своего потребителя.
 * Копированием обычного fd, закрытием и fsync владеет общий install core.
 */
export async function copyInstallCandidate(source: string, target: string): Promise<void> {
  const messages = {
    source: 'Candidate сервера должен быть непустым обычным файлом',
    read: 'Копирование candidate сервера оборвалось',
    write: 'Запись candidate сервера оборвалась',
  };

  await copyInstallFile(source, target, {
    failure: (phase) => new Error(messages[phase]),
    validateSource: requireElf,
  });
}
