import fs from 'node:fs/promises';
import path from 'node:path';
import { publishDeepSeekGeneration } from './deepseekRuntimePublication.ts';

const args = process.argv.slice(2);

if (args.length !== 4 || args[0] !== '--generation' || args[2] !== '--runtime-root') {
  throw new Error('Нужны --generation <abs> --runtime-root <abs>');
}

try {
  await fs.lstat(path.join(args[3]!, 'publish-pending.json'));

  throw new Error('Незавершённое обновление требует восстановления согласованного релиза');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}

console.log(JSON.stringify(await publishDeepSeekGeneration(args[1]!, args[3]!)));
