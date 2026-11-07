import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(process.argv[2]);
const input = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
const execute = promisify(execFile);
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { default: deepseek } = await load('server/src/lib/executors/deepseek.ts');
const { createGlmAdapter } = await load('server/src/lib/executors/glm.ts');
const { startDeepSeekServer } = await load('server/src/lib/deepseek/serverRuntime.ts');
const { resolveDeepSeekRuntimeAsync } = await load('server/src/lib/deepseek/runtimeProcess.ts');
const config = {
  rootDir: root,
  deepseekBin: path.join(root, 'bin/deepseek'),
  deepseekCacheDir: path.join(root, 'data/cache'),
  deepseekRuntimeHome: path.join(root, 'data/deepseek'),
  glmRuntimeHome: path.join(root, 'data/glm'),
};
const descriptor = await resolveDeepSeekRuntimeAsync(config);

assert.equal(descriptor.kind, 'binary');
assert.equal(descriptor.generationDir, null);
assert.equal(descriptor.metadata.packageId, input.packageId);

// Холодная распаковка и проверка пакета имеют собственный срок до boot web.
// Проверка границы consumer не измеряет скорость диска двухъядерного CI runner.
const prepared = await execute(config.deepseekBin, [
  '--cache-dir', config.deepseekCacheDir, '--verify', '--json',
], { timeout: 120000, maxBuffer: 65536 });
const verified = JSON.parse(prepared.stdout);

assert.equal(prepared.stderr, '');
assert.equal(verified.packageId, input.packageId);
assert.equal(verified.verified, true);

let diagnostics = '';

/**
 * Тест сохраняет ограниченный stderr только своего синтетического процесса.
 * На отказе стадия и хвост объясняют startup, успешный протокол остаётся чистым.
 */
function observedSpawn(...args) {
  const child = spawn(...args);

  child.stderr?.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-16_384);
  });

  return child;
}

/**
 * Различает запуск DeepSeek и GLM в общей изолированной проверке.
 * Исходная ошибка и cleanup остаются в cause; URL-токены исключены из диагностики.
 */
async function stage(label, operation) {
  diagnostics = '';

  try {
    return await operation();
  } catch (error) {
    const details = diagnostics.replace(/token=\S+/gu, 'token=<redacted>');

    throw new Error(`${label}: ${error.message}\n${details}`, { cause: error });
  }
}

/**
 * Изолированный consumer сохраняет production overlay; только модель указывает на loopback.
 * Все импорты этого процесса разрешены от копии server/shared, не от исходного checkout.
 */
async function startServer(options) {
  const combined = path.join(path.dirname(options.overlayPath), 'loopback-combined.yml');

  await fs.writeFile(combined, await fs.readFile(options.overlayPath, 'utf8')
    + await fs.readFile(input.deepseekPatch, 'utf8'), { mode: 0o600 });

  return startDeepSeekServer({
    ...options,
    overlayPath: combined,
    spawnProcess: observedSpawn,
  });
}

const first = await stage('DeepSeek first', () => deepseek.run({
  config,
  cwd: path.join(root, 'project'),
  chatKey: 'boundary-deepseek',
  model: '["deepseek-official","deepseek-v4-flash"]',
  effort: 'off',
  message: 'boundary-deepseek-first',
  env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'synthetic-loopback-key' },
  startServer,
}));
const second = await stage('DeepSeek resume', () => deepseek.run({
  config,
  cwd: path.join(root, 'project'),
  chatKey: 'boundary-deepseek',
  model: '["deepseek-official","deepseek-v4-flash"]',
  effort: 'off',
  message: 'boundary-deepseek-second',
  sessionId: first.sessionId,
  env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'synthetic-loopback-key' },
  startServer,
}));
const glm = createGlmAdapter({
  env: {
    PATH: process.env.PATH,
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_API_KEY: 'synthetic-zai-service-key',
  },
  modelEndpoint: input.glmEndpoint,
  egressGuard: input.egressGuard,
  catalog: [{ id: '["zai","glm-5.3"]', efforts: ['high'] }],
  spawn: observedSpawn,
});
const runGlm = (options = {}) => glm.run({
  config,
  cwd: path.join(root, 'project'),
  chatKey: 'boundary-glm',
  model: '["zai","glm-5.3"]',
  effort: 'high',
  message: 'boundary-glm-first',
  onSessionCreated: async () => {},
  ...options,
});
const glmFirst = await stage('GLM first', () => runGlm());
const glmSecond = await stage('GLM resume', () => runGlm({
  sessionId: glmFirst.sessionId,
  message: 'boundary-glm-second',
}));
const probe = await execute('/bin/bash', ['-c', [
  'source "$FACTORY_HOME/lib/runners/deepseek.sh"',
  'runner_deepseek_probe',
].join('\n')], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GRIGDESK_HOME: path.join(root, 'data'),
    FACTORY_HOME: path.join(root, 'engine'),
    FACTORY_FORBID_LIVE: '0',
    GRIGDESK_DEEPSEEK_NODE_BIN: process.execPath,
    GRIGDESK_DEEPSEEK_BIN: config.deepseekBin,
    GRIGDESK_DEEPSEEK_CACHE_DIR: config.deepseekCacheDir,
  },
});

assert.equal(first.sessionId, second.sessionId);
assert.equal(glmFirst.sessionId, glmSecond.sessionId);
assert.ok(probe.stdout.includes(input.packageId));

process.stdout.write(`${JSON.stringify({
  packageId: descriptor.metadata.packageId,
  deepseek: second.reply,
  glm: glmSecond.reply,
  sameDeepseekSession: first.sessionId === second.sessionId,
  sameGlmSession: glmFirst.sessionId === glmSecond.sessionId,
  factoryMetadata: true,
})}\n`);
