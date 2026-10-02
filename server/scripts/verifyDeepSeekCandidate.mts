import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDeepSeekRuntime } from '../../tools/buildDeepSeekRuntime.mts';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const vendorIndex = args.indexOf('--vendor-dir');

if (vendorIndex < 0 || !args[vendorIndex + 1]) {
  throw new Error('Candidate gate требует --vendor-dir');
}

const parent = path.join(repositoryRoot, '.state/artifacts/deepseek-vendoring/gates');

await fs.mkdir(parent, { recursive: true });

const container = await fs.mkdtemp(path.join(parent, 'candidate-'));

/**
 * Candidate собирается, проверяется compiled-тестами и удаляется в любом исходе:
 * сборка воспроизводима, а каждый прогон релизной проверки иначе оставлял бы ~240 МБ.
 */
async function runGate(): Promise<void> {
  const artifact = await buildDeepSeekRuntime({
    vendorDir: path.resolve(args[vendorIndex + 1]!),
    outputDir: path.join(container, 'generation'),
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COCKPIT_TEST_DEEPSEEK_ARTIFACT: artifact,
    NODE_TEST_MAX_RSS_MB: '4096',
  };

  delete env.NODE_TEST_CONTEXT;

  const child = spawn('bash', [path.join(repositoryRoot, 'tests/run-node-tests-safe.sh'),
    '--test', '--test-concurrency=2', '--test-name-pattern=настоящ',
    path.join(repositoryRoot, 'tests/server/deepseek-vendor-build.test.js'),
    path.join(repositoryRoot, 'tests/server/deepseek-acp-settings.test.js'),
    path.join(repositoryRoot, 'tests/server/provider-settings-consumers.test.js'),
    path.join(repositoryRoot, 'tests/server/providers-native-settings-route.test.js'),
    path.join(repositoryRoot, 'tests/server/deepseek-vendored-chat.test.js'),
    path.join(repositoryRoot, 'tests/server/deepseek-factory-settings.test.js'),
    path.join(repositoryRoot, 'tests/server/deepseek-runtime-rollback.test.js'),
    path.join(repositoryRoot, 'tests/server/deepseek-vendored-settings.test.js')], {
    cwd: repositoryRoot,
    env,
    stdio: 'inherit',
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  if (code !== 0) {
    throw new Error(`Compiled DeepSeek parity gate завершился ${code}`);
  }
}

try {
  await runGate();
} finally {
  await fs.rm(container, { recursive: true, force: true });
}
