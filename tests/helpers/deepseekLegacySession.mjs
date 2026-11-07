import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DEEPSEEK_BASH_TOOL } from '../../server/src/lib/deepseek/contract.ts';
import { buildLaunchFiles } from '../../server/src/lib/deepseek/profile.ts';
import { buildGlmLaunchFiles } from '../../server/src/lib/glm/profile.ts';
import { buildDeepSeekChildEnv } from '../../server/src/lib/deepseek/env.ts';
import { buildGlmChildEnv } from '../../server/src/lib/glm/env.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';
import { ensureTestDeepSeekArtifact } from './deepseekRuntimeArtifact.mts';
import { writeDeepSeekLoopbackOverlay } from './deepseekLoopback.mts';
import { writeGlmEgressGuard } from './glmProductionFixture.mts';
import { openDeepSeekStream } from '../../server/src/lib/deepseek/serverEvents.ts';
import { deepSeekTestArtifactsRoot } from './deepseekBinary.mts';
/**
 * Только тест перехода запускает проверенный legacy entry на Node сервера.
 * Production resolver при этом остаётся binary-only; журнал создаёт настоящий embedded Harness.
 */
export async function seedLegacySession({ root, cwd, home, endpoint, provider, model, env }) {
  const artifact = await ensureTestDeepSeekArtifact();
  const metadata = JSON.parse(await fs.readFile(path.join(artifact, 'runtime.json'), 'utf8'));
  const launchDir = path.join(root, 'legacy-seed-launch');
  const document = path.join(launchDir, 'settings.yaml');
  const base = {
    launchDir,
    cwd,
    workspaceRoot: cwd,
    projectRoot: cwd,
    mode: 'workspace-write',
    approval: 'ask',
    transport: 'web',
    hooks: {
      bashToolName: DEEPSEEK_BASH_TOOL,
      ssh: true,
      db: false,
      strictDb: false,
      instructions: { projectRoot: cwd }
    },
  };

  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(launchDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(document, '{}\n', { mode: 0o600 });

  const launch = provider === 'glm'
    ? await buildGlmLaunchFiles({
      ...base,
      accessMode: 'api',
      model: 'glm-5.3',
      settingsDocument: document,
      modelEndpoint: endpoint,
      egressGuard: await writeGlmEgressGuard(launchDir),
    }) : await buildLaunchFiles(base);

  if (provider === 'deepseek') {
    const original = await fs.readFile(launch.overlayPath, 'utf8');
    const extra = await writeDeepSeekLoopbackOverlay({
      root: launchDir,
      artifact,
      endpoint,
      document
    });
    const combined = path.join(launchDir, 'combined.yml');

    await fs.writeFile(combined, original + await fs.readFile(extra, 'utf8'), { mode: 0o600 });
    launch.overlayPath = combined;
  }

  const childEnv = provider === 'glm'
    ? buildGlmChildEnv({
      source: env,
      dshHome: home,
      mode: 'api'
    })
    : buildDeepSeekChildEnv({ source: env, dshHome: home });
  const options = {
    bin: process.execPath,
    overlayPath: launch.overlayPath,
    cwd,
    env: childEnv,
    message: `legacy-${provider}-first-prompt`,
    model,
    effort: provider === 'glm' ? 'high' : 'off',
    signal: AbortSignal.timeout(60000),
  };
  let diagnostics = '';
  let observer;
  let server;
  const events = [];
  const result = await runDeepSeekServerTurn({
    ...options,
    onSessionCreated: (sessionId) => {
      observer = openDeepSeekStream({
        client: server.client,
        endpoint: 'session/follow',
        args: { request: { address: { kind: 'session', sessionId } } },
        onItem: (item) => {
          if (item.type === 'event') {
            events.push(item.event);
          }
        },
        onClose: () => {},
      });
      void observer.ready.catch(() => {});
    },
    startServer: async (input) => {
      server = await startDeepSeekServer({
        ...input,
        spawnProcess: (_command, args, settings) => {
          const child = spawn(process.execPath, [path.join(artifact, 'entry.mjs'), ...args], settings);

          child.stderr.on('data', (chunk) => {
            diagnostics = (diagnostics + String(chunk)).slice(-16384);
          });

          return child;
        },
      });

      return server;
    },
  }).catch(async (error) => {
    const directory = path.join(deepSeekTestArtifactsRoot(), 'legacy-seed-failures');
    const report = path.join(directory, `${randomUUID()}.json`);

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(report, JSON.stringify({
      events,
      stderr: diagnostics.replace(/token=\S+/gu, 'token=<redacted>'),
    }, null, 2), { mode: 0o600 });

    throw new Error(error.message + '\n' + JSON.stringify({ steps: error.steps, code: error.code })
      + '\n' + report);
  }).finally(() => {
    observer?.close();
  });

  await fs.rm(launchDir, { recursive: true, force: true });

  return { ...result, metadata };
}
