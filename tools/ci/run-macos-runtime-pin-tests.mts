import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { assertRuntimePinDirectory, collectRuntimePinOutcomes } from './runtimePinEvidence.mts';

const mode = process.argv[2];
const directory = process.env.GRIGDESK_RUNTIME_PIN_REPORT_DIR ?? '';
const root = path.resolve(import.meta.dirname, '../..');

if (process.argv.length !== 3 || mode !== 'source' && mode !== 'packaged'
  || process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('mac_runtime_pin_mode_invalid');
}

await assertRuntimePinDirectory(directory);

const owned = await fs.mkdtemp(path.join(directory, 'pin-'));
const witness = path.join(owned, 'witness');
const output = path.join(owned, 'events.ndjson');
const testFile = path.join(root, `tests/server/macos-release-runtime-pin-${mode}.test.mts`);
const reporter = path.join(root, 'tools/ci/runtime-pin-reporter.mjs');

await fs.mkdir(witness, { mode: 0o700 });

const child = spawn('bash', ['tests/run-node-tests-safe.sh', '--test', '--test-concurrency=1',
  '--test-reporter=' + reporter, '--test-reporter-destination=' + output, testFile], {
  cwd: root,
  env: {
    ...process.env,
    NODE_TEST_MAX_RSS_MB: '4096',
    GRIGDESK_RUNTIME_PIN_TEST_FILE: testFile,
    GRIGDESK_RUNTIME_PIN_WITNESS_DIR: witness,
  },
  stdio: 'inherit',
});
const [code] = await once(child, 'exit');

if (code !== 0) {
  process.exitCode = code ?? 1;

  throw new Error('mac_runtime_pin_tests_failed');
}

const events = (await fs.readFile(output, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const outcomes = await collectRuntimePinOutcomes(mode, events, witness);

await fs.writeFile(path.join(directory, 'runtime-pin-outcomes.json'), canonicalJson(outcomes) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
