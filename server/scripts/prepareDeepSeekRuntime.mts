import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDeepSeekRuntimeAsync } from '../src/lib/deepseek/runtimeProcess.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Прежний prepare entrypoint теперь только проверяет независимую установленную поставку.
// deps/run/dev не собирают Harness и не меняют binary, cache или homes чатов.
try {
  if (process.argv.length !== 2) {
    throw new Error('Legacy prepare/recover сняты; используйте install:binary для готового ELF');
  }

  const runtime = await resolveDeepSeekRuntimeAsync({
    rootDir: root,
    deepseekBinOverride: process.env.GRIGDESK_DEEPSEEK_BIN,
    deepseekBin: path.join(root, 'bin/deepseek'),
  });

  process.stdout.write(`${JSON.stringify({
    packageId: runtime.metadata!.packageId,
    runtimeVersion: runtime.runtimeVersion,
  })}\n`);
} catch {
  process.stderr.write('DeepSeek не установлен или несовместим. Установите готовый ELF: '
    + 'npm --prefix deepseek run install:binary -- --binary <candidate> '
    + '--target bin/deepseek --host-contract server/deepseek-host-contract.json\n');
  process.exitCode = 1;
}
