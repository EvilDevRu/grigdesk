import path from 'node:path';

export interface CandidateGateOptions {
  repository: string;
  vendorDir: string;
  outputDir: string;
  nodeCacheDir: string;
}

export interface CandidateGateRun {
  (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }>;
}

const COMPILED = [
  'deepseek-vendor-build', 'deepseek-acp-settings', 'deepseek-vendored-chat',
  'deepseek-factory-settings', 'deepseek-runtime-rollback', 'deepseek-vendored-settings',
  'provider-settings-consumers', 'providers-native-settings-route',
  'glm-vendored-build', 'glm-vendored-protocol', 'glm-vendored-profile', 'glm-vendored-turn',
  'glm-vendored-policy', 'glm-vendored-mcp', 'glm-vendored-catalog', 'glm-vendored-session',
  'glm-vendored-stop',
];

/**
 * Source-sync gate собирает именно переданный vendor, затем запускает package и host parity.
 * Внедряется только запуск команд; production CLI использует настоящие дочерние процессы.
 */
export async function runDeepSeekCandidateGate(
  options: CandidateGateOptions,
  run: CandidateGateRun,
): Promise<void> {
  if (!Object.values(options).every(path.isAbsolute)) {
    throw new Error('Candidate gate требует абсолютные пути');
  }

  const built = await run(process.execPath, [
    path.join(options.repository, 'deepseek/scripts/buildBinary.mts'),
    '--vendor-dir', options.vendorDir,
    '--out-dir', options.outputDir,
    '--node-cache-dir', options.nodeCacheDir,
  ], process.env);

  if (built.code !== 0) {
    throw new Error(`DeepSeek candidate build завершился ${built.code}`);
  }

  const payload = JSON.parse(built.stdout).payload?.sha256;

  if (typeof payload !== 'string' || !/^[a-f0-9]{64}$/u.test(payload)) {
    throw new Error('Candidate builder не подтвердил payload');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GRIGDESK_TEST_DEEPSEEK_BINARY: path.join(options.outputDir, 'deepseek'),
    GRIGDESK_TEST_DEEPSEEK_CACHE_DIR: path.join(options.outputDir, 'test-cache'),
    GRIGDESK_TEST_DEEPSEEK_PAYLOAD: path.join(options.nodeCacheDir, 'payloads', payload, 'payload.zip'),
    GRIGDESK_TEST_GLM_DELIVERY: 'binary',
    GRIGDESK_RELEASE_PUBLISH_CONTRACT: '2',
    NODE_TEST_MAX_RSS_MB: '4096',
  };

  delete env.NODE_TEST_CONTEXT;
  delete env.GRIGDESK_TEST_DEEPSEEK_ARTIFACT;

  const packageDir = path.join(options.repository, 'deepseek');
  const commands: [string, string[]][] = [
    ['bash', [
      path.join(options.repository, 'tests/run-node-tests-safe.sh'),
      path.join(options.repository, 'tests/helpers/deepseekBinary.mts'), '--prepare-suite',
    ]],
    ['npm', ['--prefix', packageDir, 'run', 'typecheck']],
    ['npm', ['--prefix', packageDir, 'test']],
    ['npm', ['--prefix', packageDir, 'run', 'test:sea']],
    ['bash', [
      path.join(options.repository, 'tests/run-node-tests-safe.sh'),
      '--test', '--test-concurrency=2',
      ...COMPILED.map((name) => path.join(options.repository, `tests/server/${name}.test.js`)),
    ]],
  ];

  for (const [command, args] of commands) {
    const result = await run(command, args, env);

    if (result.code !== 0) {
      throw new Error(`DeepSeek candidate gate завершился ${result.code}`);
    }
  }
}
