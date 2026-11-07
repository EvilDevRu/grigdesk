import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGenerationAsync } from '../../server/src/lib/glm/generation.ts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from './glmArtifactFixture.mts';

const FAKE_WEB = path.resolve(import.meta.dirname, '../fixtures/deepseek-harness/fakeWeb.mjs');

/**
 * Generation-фикстура GLM поверх фейкового DSH web: настоящий путь адаптера (generation,
 * identity, launch, процесс), подменён только сам runtime. Допуск — identity этой фикстуры.
 */
export async function createGlmFakeRuntime(t: { after: (fn: () => unknown) => void }, scenario: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-fake-runtime-'));
  const project = path.join(root, 'project');
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  const children: ChildProcess[] = [];

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.writeFile(scenarioFile, JSON.stringify(scenario));
  await fs.writeFile(logFile, '');
  await writeGlmArtifactFixture(path.join(root, 'generation'), {
    llmPiAi: GLM_FIXTURE_PLUGIN,
    entry: [
      'if (process.argv[2] === "-V") { console.log("0.1.5-rc.2"); process.exit(0); }',
      `process.argv.push("--scenario", ${JSON.stringify(scenarioFile)},`
        + ` "--log", ${JSON.stringify(logFile)});`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_WEB).href)});`,
      '',
    ].join('\n'),
  });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  const config = {
    rootDir: project,
    deepseekBin: path.join(root, 'generation', 'deepseek'),
    deepseekCacheDir: path.join(root, 'cache'),
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identity = glmCompatibilityIdentity((await describeGlmGenerationAsync(config)).runtime, 'api');
  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: 'synthetic-zai-key',
    },
    admission: [{ mode: 'api', compatibility: identity }],
    spawn: ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);

      children.push(child);

      return child;
    }) as typeof spawn,
  });

  return {
    root,
    project,
    config,
    identity,
    adapter,
    children,
    scenario: (value: unknown) => fs.writeFile(scenarioFile, JSON.stringify(value)),
    log: async () => (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>),
  };
}
