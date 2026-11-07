// Малый metadata/ACP double для contract-тестов Factory, не для SEA/parity.
// Metadata-команда не открывает сценарий и не создаёт дочерние процессы.
import { spawn } from 'node:child_process';

import { runtimeInfoFixture } from '../../helpers/deepseekMetadataFixture.mts';

const args = process.argv.slice(2);
const info = runtimeInfoFixture();

if (args.includes('--runtime-info')) {
  process.stdout.write(`${JSON.stringify(info)}\n`);
  process.exit(0);
}
if (args.includes('-V') || args.includes('--version')) {
  process.stdout.write(`${info.upstreamVersion}\n`);
  process.exit(0);
}

const expectedAt = args.indexOf('--expect-package-id');

if (expectedAt >= 0 && args[expectedAt + 1] !== info.packageId) {
  throw new Error('Contract fixture получила чужой packageId');
}

const markerAt = args.indexOf('--stubborn-marker');

if (markerAt >= 0) {
  spawn('/bin/bash', ['-c', 'trap "" TERM; exec -a "$1" sleep 60', 'fixture', args[markerAt + 1]!], {
    stdio: 'inherit',
  });
}

await import('./fakeAcp.mts');
