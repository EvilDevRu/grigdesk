import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
} from 'node:fs';
import path from 'node:path';

import { sha256 } from '../../../shared/node/hash.ts';

export const FACTORY_GO_DESCRIPTOR = 'server/factory-engine.json';
export const FACTORY_GO_BINARY = 'engine/bin/factory';
export const FACTORY_PROFILE_ABI = 'engine/lib/delivery_contract.py';

export interface FactoryGoDescriptor {
  schema: 1;
  protocol: 'go-v1';
  kind: 'elf' | 'macho';
  os: string;
  arch: string;
  path: typeof FACTORY_GO_BINARY;
  mode: number;
  sha256: string;
  profileAbiSha256: string;
}

function invalidFactory(): Error {
  return Object.assign(new Error('Поставке фабрики не соответствует бинарник или проектный ABI'),
    { code: 'factory_runtime_engine_invalid' });
}

/**
 * Заголовок проверяется по фактическим байтам, без запуска кандидата.
 * Режим desktop допускает ELF Linux и Mach-O Apple Silicon.
 */
export function factoryBinaryKind(bytes: Buffer, os: string, arch: string): FactoryGoDescriptor['kind'] {
  if (bytes.length >= 64 && os === 'linux' && ['x64', 'arm64'].includes(arch)
    && bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))
    && [2, 3].includes(bytes.readUInt16LE(16)) && bytes.readUInt16LE(18) === (arch === 'x64' ? 62 : 183)) {
    return 'elf';
  }

  if (bytes.length >= 32 && os === 'darwin' && arch === 'arm64'
    && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c
    && bytes.readUInt32LE(12) === 2) {
    return 'macho';
  }

  throw invalidFactory();
}

/**
 * Ограничивает чтение одним обычным inode и проверяет, что имя всё ещё на него указывает.
 * Чужой владелец, ссылки и лишние биты режима отзывают допуск до запуска.
 */
function verifiedBytes(file: string, mode: number, limit: number): Buffer {
  const uid = process.getuid?.();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const info = fstatSync(fd);

    if (!info.isFile() || info.nlink !== 1 || realpathSync(file) !== file
      || (info.mode & 0o7777) !== mode || info.size > limit
      || (uid !== undefined && info.uid !== uid && info.uid !== 0)) {
      throw invalidFactory();
    }

    const bytes = readFileSync(fd);
    const current = lstatSync(file);

    if (bytes.length !== info.size || current.ino !== info.ino || current.dev !== info.dev
      || current.ctimeMs !== info.ctimeMs) {
      throw invalidFactory();
    }

    return bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Дескриптор входит в проверяемый payload. Если он опубликован, неполный или
 * чужой ABI закрывает допуск. Старый пакет распознаётся по отсутствию дескриптора.
 */
export function readFactoryGoDescriptor(
  root: string, os: string = process.platform, arch: string = process.arch,
): FactoryGoDescriptor | null {
  const file = path.join(root, FACTORY_GO_DESCRIPTOR);

  try {
    lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  try {
    const meta = JSON.parse(verifiedBytes(file, 0o444, 16 * 1024).toString('utf8')) as FactoryGoDescriptor;
    const keys = ['arch', 'kind', 'mode', 'os', 'path', 'profileAbiSha256', 'protocol', 'schema', 'sha256'];

    if (Object.keys(meta).sort().join() !== keys.join()
      || meta.schema !== 1 || meta.protocol !== 'go-v1' || meta.os !== os || meta.arch !== arch
      || meta.path !== FACTORY_GO_BINARY || meta.mode !== 0o555) {
      throw invalidFactory();
    }

    const bytes = verifiedBytes(path.join(root, FACTORY_GO_BINARY), meta.mode, 64 * 1024 * 1024);
    const profile = verifiedBytes(path.join(root, FACTORY_PROFILE_ABI), 0o444, 1024 * 1024);

    if (meta.kind !== factoryBinaryKind(bytes, os, arch)
      || meta.sha256 !== sha256(bytes) || meta.profileAbiSha256 !== sha256(profile)) {
      throw invalidFactory();
    }

    return meta;
  } catch {
    throw invalidFactory();
  }
}
