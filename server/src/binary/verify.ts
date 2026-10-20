import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { sha256File } from '../../../shared/node/hash.ts';
import type { ServerBinaryInfo } from '../../../shared/runtime/serverBinary.ts';
import type { ServerPackageManifest } from './metadata.ts';

const execute = promisify(execFile);

export interface RuntimeVerificationPorts {
  checkNode(): Promise<ServerBinaryInfo['runtime']>;
  loadNative(file: string): Promise<void>;
  hashElf(): Promise<string>;
}

/**
 * Warm не вызывает hash/native/Node probes: полный verifier имеет отдельную команду.
 * Full сверяет ABI и каждый binding отдельным процессом до вычисления ELF SHA.
 */
export async function verifyRuntimePorts(input: {
  full: boolean;
  native: string[];
}, ports: RuntimeVerificationPorts) {
  if (!input.full) {
    return null;
  }

  const runtime = await ports.checkNode();

  if (runtime.node !== '24.21.0' || runtime.abi !== '137'
    || runtime.platform !== 'linux' || runtime.arch !== 'x64') {
    throw Object.assign(new Error('Node runtime или ABI серверной поставки не совпал'), {
      code: 'server_runtime_invalid',
    });
  }

  for (const file of input.native) {
    await ports.loadNative(file);
  }

  const elfSha256 = await ports.hashElf();

  if (!/^[a-f0-9]{64}$/u.test(elfSha256)) {
    throw Object.assign(new Error('Некорректный SHA серверного ELF'), {
      code: 'server_elf_invalid',
    });
  }

  return {
    runtime,
    elfSha256,
    nativeBindingsVerified: input.native.length,
  };
}

/**
 * Private receipt проверяет согласованность установленного файла с approved bytes.
 * Его отсутствие разрешает переносимый candidate; verify никогда receipt не изменяет.
 */
async function verifyReceipt(binary: string, digest: string): Promise<void> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(`${binary}.grigdesk-server.json`, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (!handle) {
    return;
  }

  try {
    const info = await handle.stat();

    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600
      || info.size > 65536) {
      throw new Error('Некорректный private receipt серверного ELF');
    }

    const value = JSON.parse(await handle.readFile('utf8'));

    if (Object.keys(value).sort().join(',') !== 'approved,format,target'
      || value.format !== 1 || value.target !== binary || !Array.isArray(value.approved)
      || value.approved.some((item: unknown) => typeof item !== 'string'
        || !/^[a-f0-9]{64}$/u.test(item)) || !value.approved.includes(digest)) {
      throw new Error('SHA серверного ELF не подтверждён private receipt');
    }
  } finally {
    await handle.close();
  }
}

/**
 * Проверяет реальные Node/native из защищённого индекса без импорта app/config.
 * Файловая полная проверка уже выполнена cache под lease перед этим шагом.
 */
export async function verifyPreparedRuntime(input: {
  root: string;
  binary: string;
  manifest: ServerPackageManifest;
}) {
  const node = path.join(input.root, 'runtime/node/bin/node');
  const native = input.manifest.payload.entries.filter((entry) => entry.type === 'file'
    && entry.path.endsWith('.node')).map((entry) => path.join(input.root, entry.path));
  const options = {
    cwd: '/',
    env: { PATH: '', NODE_V8_COVERAGE: '' },
    timeout: 30000,
    maxBuffer: 65536,
  };

  if (native.length !== 2) {
    throw new Error('Защищённый index требует два native bindings');
  }

  const proof = await verifyRuntimePorts({ full: true, native }, {
    checkNode: async () => {
      const result = await execute(node, ['-p', 'JSON.stringify({node:process.versions.node,'
        + 'abi:process.versions.modules,platform:process.platform,arch:process.arch})'], options);

      return JSON.parse(result.stdout) as ServerBinaryInfo['runtime'];
    },
    loadNative: async (file) => {
      await execute(node, ['-e', 'require(process.argv[1])', file], options);
    },
    hashElf: () => sha256File(input.binary),
  });

  if (!proof) {
    throw new Error('Полная проверка серверного runtime не выполнена');
  }

  await verifyReceipt(input.binary, proof.elfSha256);

  return {
    ok: true,
    verified: true,
    packageId: input.manifest.packageId,
    ...proof,
    filesVerified: input.manifest.payload.entries.filter((entry) => entry.type === 'file').length,
  };
}
