import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { decodeDeepSeekHostContract } from '../../../../shared/chat/deepSeekBinary.ts';
import { assertDeepSeekGlmApiAdmission } from '../../../../shared/node/glmCompatibility.ts';
import { removePrivateTree } from '../../../../shared/node/files.ts';
import { sha256File } from '../../../../shared/node/hash.ts';
import { probeDeepSeekBinary } from './binaryProbe.ts';

const run = promisify(execFile);

/**
 * Readiness относится к установленному ELF и требованиям target, а не к generation staging.
 * Полный verify использует disposable home/cache и никогда не получает ключи модели.
 */
export async function assertDeepSeekBinaryReady(
  binary: string,
  hostFile: string,
  { fullVerify = true }: { fullVerify?: boolean } = {},
) {
  let stage: string | undefined;

  try {
    const host = decodeDeepSeekHostContract(JSON.parse(await fs.readFile(hostFile, 'utf8')));
    const digest = await sha256File(binary);
    const info = await probeDeepSeekBinary(binary, { hostContract: host });

    assertDeepSeekGlmApiAdmission(info, host);

    if (fullVerify) {
      stage = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-readiness-'));

      const result = await run(binary, ['--cache-dir', path.join(stage, 'cache'), '--verify', '--json'], {
        timeout: 120000,
        maxBuffer: 65536,
        cwd: stage,
        env: {
          PATH: '',
          HOME: stage,
          GRIGDESK_HOME: stage,
          DSH_HOME: path.join(stage, 'home'),
          TMPDIR: stage,
          NODE_V8_COVERAGE: '',
        },
      });
      const proof = JSON.parse(result.stdout);

      if (result.stderr || !proof.verified || !proof.glmPlugin || proof.packageId !== info.packageId) {
        throw new Error('verify не подтвердил установленный ELF');
      }
    }

    if (await sha256File(binary) !== digest) {
      throw new Error('ELF изменился во время readiness');
    }

    return { info, sha256: digest };
  } catch (cause) {
    throw Object.assign(new Error('Установленный DeepSeek не готов для целевого GrigDesk. '
      + 'Установите совместимый ELF: npm --prefix deepseek run install:binary -- '
      + '--binary <candidate> --target bin/deepseek --host-contract server/deepseek-host-contract.json', {
      cause,
    }), { code: 'deepseek_binary_not_ready', safeCode: 'deepseek_binary_not_ready' });
  } finally {
    if (stage) {
      await removePrivateTree(stage);
    }
  }
}
