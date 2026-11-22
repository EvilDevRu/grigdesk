import type { FileHandle } from 'node:fs/promises';

import { copyInstallFile } from '../../../shared/node/binaryInstall.ts';
import { isArm64MachOExecutable } from '../../../shared/node/machO.ts';
import { serverSeaHostTarget, type NodeRuntime } from '../../../shared/node/nodeRuntime.ts';

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

// Проверяет 64-битный ELF GNU/Linux ARM64 на открытом дескрипторе кандидата.
// Одинаковая метка ELF у x64 и ARM64 не даёт допуск на другую архитектуру.
async function requireArm64Elf(input: FileHandle): Promise<void> {
  const header = Buffer.alloc(64);
  const { bytesRead } = await input.read(header, 0, header.length, 0);
  const elf64LE = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);

  if (bytesRead !== header.length || !header.subarray(0, elf64LE.length).equals(elf64LE)
    || ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== 183) {
    throw new Error('Candidate сервера должен быть ELF ARM64');
  }
}

/**
 * Проверяет 64-битный заголовок Mach-O, архитектуру ARM64 и тип executable.
 * Переименование файла и Mach-O другой архитектуры недостаточны.
 */
async function requireArm64MachO(input: FileHandle): Promise<void> {
  const header = Buffer.alloc(32);
  const { bytesRead } = await input.read(header, 0, header.length, 0);

  if (!isArm64MachOExecutable(header.subarray(0, bytesRead))) {
    throw new Error('Candidate сервера должен быть Mach-O ARM64');
  }
}

export function serverExecutableGuard(target: NodeRuntime['platform']) {
  if (target === 'linux-arm64') {
    return requireArm64Elf;
  }

  return target === 'darwin-arm64' ? requireArm64MachO : requireElf;
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
    validateSource: serverExecutableGuard(serverSeaHostTarget()),
  });
}
