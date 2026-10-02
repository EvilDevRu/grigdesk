import fs from 'node:fs/promises';
import path from 'node:path';
import { activateDeepSeekGeneration } from './deepseekRuntimePublication.ts';

const args = process.argv.slice(2);

if (args.length !== 4 || args[0] !== '--runtime-root' || args[2] !== '--build-id') {
  throw new Error('Нужны --runtime-root <abs> --build-id <64 hex>');
}

try {
  await fs.lstat(path.join(args[1]!, 'publish-pending.json'));

  throw new Error('Незавершённое обновление требует восстановления согласованного релиза');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}

await activateDeepSeekGeneration(args[1]!, args[3]!);
console.log('Проверенная generation активирована; старые builds и homes сохранены.');
