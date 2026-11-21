import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../../../shared/node/hash.ts';
import {
  FACTORY_GO_DESCRIPTOR, FACTORY_PROFILE_ABI, factoryBinaryKind, factoryGoBinaryPath,
} from '../../src/lib/factoryGoDescriptor.ts';
import type { FactoryGoDescriptor } from '../../src/lib/factoryGoDescriptor.ts';

interface FactoryCandidateInput {
  root: string;
  binary: string;
  profileAbi: string;
  os: string;
  arch: string;
}

async function readAsset(file: string, limit: number): Promise<Buffer> {
  const info = await lstat(file);

  if (await realpath(file) !== file || !info.isFile() || info.size > limit) {
    throw new Error('Некорректный исходный файл поставки фабрики');
  }

  return readFile(file);
}

/**
 * Записывает новый файл под проверенным именем build staging.
 * Установка точного режима нужна для последующей сверки signed inventory.
 */
async function addFile(root: string, name: string, contents: Buffer | string, mode: number) {
  const target = path.join(root, name);

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, { flag: 'wx', mode });
  await chmod(target, mode);
}

/**
 * Добавляет один бинарник и один публичный ABI-файл в приватный staging.
 * Маркер публикуется после готовых байтов, неправильная архитектура отвергается до записи.
 */
export async function stageFactoryCandidate(input: FactoryCandidateInput): Promise<FactoryGoDescriptor> {
  const [bytes, profile] = await Promise.all([
    readAsset(input.binary, 64 * 1024 * 1024),
    readAsset(input.profileAbi, 1024 * 1024),
  ]);
  const descriptor: FactoryGoDescriptor = {
    schema: 1,
    protocol: 'go-v1',
    kind: factoryBinaryKind(bytes, input.os, input.arch),
    os: input.os,
    arch: input.arch,
    path: factoryGoBinaryPath(input.os),
    mode: 0o555,
    sha256: sha256(bytes),
    profileAbiSha256: sha256(profile),
  };

  await mkdir(path.join(input.root, 'engine'), { recursive: false });
  await addFile(input.root, descriptor.path, bytes, descriptor.mode);
  await addFile(input.root, FACTORY_PROFILE_ABI, profile, 0o444);
  await addFile(input.root, FACTORY_GO_DESCRIPTOR, JSON.stringify(descriptor) + '\n', 0o444);

  return descriptor;
}
