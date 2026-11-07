import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TestContext } from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import type { GlmTurnOptions } from '../../server/src/lib/glm/runtime.ts';
import { deepSeekTestArtifactsRoot, ensureTestDeepSeekBinaryPair } from './deepseekBinary.mts';
import { startGlmLoopback } from './glmLoopback.mts';
import type { GlmLoopbackOptions } from './glmLoopback.mts';
import { GLM_SERVICE_KEY, writeGlmEgressGuard } from './glmProductionFixture.mts';

type BinaryPair = Awaited<ReturnType<typeof ensureTestDeepSeekBinaryPair>>;

/**
 * Policy-файл должен быть виден hook: workspace-write скрывает host /tmp своим tmpfs.
 * Отдельный artifact root сохраняет настоящий sandbox без дополнительных разрешений.
 */
export async function createGlmBinaryFixtureRoot(prefix: string): Promise<string> {
  const parent = path.join(deepSeekTestArtifactsRoot(), 's13b/fs-fixtures');

  await fs.mkdir(parent, { recursive: true, mode: 0o700 });

  return fs.mkdtemp(path.join(parent, prefix));
}

/**
 * Настоящие ELF A/B используют production GLM adapter и отдельный private home.
 * Только admission теста и модельный endpoint заданы явно; внешний fetch запрещён.
 */
export async function glmBinaryFixture(t: TestContext, options: {
  pair?: BinaryPair;
  respond?: GlmLoopbackOptions['respond'];
} = {}) {
  const pair = options.pair ?? await ensureTestDeepSeekBinaryPair();
  const root = await createGlmBinaryFixtureRoot('glm-binary-');
  const cwd = path.join(root, 'project');
  const model = '["zai","glm-5.3"]';
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    respond: options.respond ?? (async () => ({
      kind: 'stream',
      deltas: [{ role: 'assistant', content: 'glm-binary-ok' }],
    })),
  });

  t.after(async () => {
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(cwd);

  const plugin = pair.a.info.glm.inputs.llmPiAi;

  if (!plugin) {
    throw new Error('Настоящий candidate не объявляет GLM plugin');
  }

  const identity = glmCompatibilityIdentity({ ...pair.a.info.glm.inputs, llmPiAi: plugin }, 'api');
  const config = {
    deepseekRuntimeMode: 'binary' as const,
    deepseekBin: pair.a.binary,
    deepseekCacheDir: pair.a.cacheDir,
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const launches: {
    home: string;
    command: string;
    args: readonly string[];
  }[] = [];
  const deps = {
    env: {
      PATH: process.env.PATH,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY,
    },
    admission: [{ mode: 'api' as const, compatibility: identity }],
    modelEndpoint: mock.endpoint,
    egressGuard: await writeGlmEgressGuard(root),
    catalog: [{ id: model, efforts: ['low', 'high', 'max'] }],
    spawn: ((...args: Parameters<typeof spawn>) => {
      const [command, commandArgs, settings] = args;

      launches.push({
        home: String(settings?.env?.DSH_HOME),
        command: String(command),
        args: [...commandArgs],
      });

      return spawn(...args);
    }) as typeof spawn,
  };
  const adapter = createGlmAdapter(deps);
  const run = adapter.run;

  if (!run) {
    throw new Error('Допущенный test api не объявляет run');
  }

  return {
    pair,
    root,
    cwd,
    model,
    mock,
    config,
    launches,
    deps,
    adapter,
    run: (input: Partial<GlmTurnOptions> = {}) => run({
      config,
      cwd,
      chatKey: 'fixture-chat',
      message: 'fixture-message',
      model,
      signal: AbortSignal.timeout(60000),
      onSessionCreated: async () => {},
      ...input,
    }),
  };
}
