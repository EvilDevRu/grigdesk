import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { removePrivateTree } from '../../shared/node/files.ts';
import { runDeepSeekCandidateGate } from './deepSeekCandidateGate.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);

if (args.length !== 2 || args[0] !== '--vendor-dir' || !args[1]) {
  throw new Error('Candidate gate требует --vendor-dir <каталог>');
}

const artifactRoot = process.env.GRIGDESK_TEST_DEEPSEEK_ROOT
  ?? path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'deepseek-binary');
const parent = path.join(artifactRoot, 'gates');
const nodeCacheDir = path.resolve(process.env.GRIGDESK_DEEPSEEK_NODE_CACHE
  ?? path.join(parent, '../node-cache'));
const execute = promisify(execFile);

await fs.mkdir(parent, { recursive: true, mode: 0o700 });

const container = await fs.mkdtemp(path.join(parent, 'candidate-'));
const reports = await fs.mkdtemp(path.join(parent, 'reports-'));
let stage = 0;

try {
  await runDeepSeekCandidateGate({
    repository,
    vendorDir: path.resolve(args[1]),
    outputDir: container,
    nodeCacheDir,
  }, async (command, commandArgs, env) => {
    const log = path.join(reports, `${++stage}.log`);

    try {
      const result = await execute(command, commandArgs, {
        cwd: repository,
        env,
        maxBuffer: 32 * 1024 * 1024,
      });

      await fs.writeFile(log, result.stdout + '\n' + result.stderr, { mode: 0o600 });

      if (commandArgs[0]?.endsWith('/buildBinary.mts')) {
        process.stdout.write('DeepSeek candidate ELF собран и проверен\n');
      } else {
        process.stdout.write(result.stdout);
      }

      process.stderr.write(result.stderr);

      return { code: 0, stdout: result.stdout };
    } catch (error) {
      const failure = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };

      await fs.writeFile(log, (failure.stdout ?? '') + '\n' + (failure.stderr ?? ''), {
        mode: 0o600,
      });
      process.stderr.write(`DeepSeek candidate: отказ ступени ${stage}, журнал ${log}\n`);
      process.stdout.write(failure.stdout ?? '');
      process.stderr.write(failure.stderr ?? '');

      return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '' };
    }
  });
} finally {
  await removePrivateTree(container);
}
