// Пробы вызывают настоящие native bindings и workers из распакованной generation.
// Исходные тела S01b сохранены: проверяется обычный упакованный Node, а не Node сервера.

export const nativeSource = String.raw`
const path = require('node:path');
const { createRequire } = require('node:module');
const payloadRoot = process.argv[2] || __dirname;
const requireRuntime = createRequire(path.join(payloadRoot, 'generation/package.json'));

/**
 * Каждый smoke действительно вызывает native binding закреплённого пакета.
 * Ошибки сохраняются отдельно, чтобы отказ одного addon не скрывал результаты остальных.
 */
async function smoke() {
  const addons = {};
  const errors = {};
  const checks = {
    'node-pty': () => {
      const pty = requireRuntime('node-pty');

      if (typeof pty.spawn !== 'function') {
        throw new Error('node-pty не экспортирует spawn');
      }
    },
    'system.node': () => {
      require(path.join(payloadRoot,
        'generation/native/system/packages/linux-x64/bin/glibc/system.node'));
    },
    sharp: async () => {
      const sharp = requireRuntime('sharp');

      await sharp({ create: {
        width: 1,
        height: 1,
        channels: 3,
        background: '#ffffff',
      } }).png().toBuffer();
    },
    koffi: () => {
      const koffi = requireRuntime('koffi');
      const libc = koffi.load('libc.so.6');
      const getpid = libc.func('int getpid(void)');

      if (getpid() !== process.pid) {
        throw new Error('koffi вернул чужой PID');
      }
    },
  };

  for (const [name, check] of Object.entries(checks)) {
    try {
      await check();
      addons[name] = true;
    } catch (error) {
      addons[name] = false;
      errors[name] = String(error.message).slice(0, 1000);
    }
  }

  const loaded = process.report.getReport().sharedObjects.filter((file) => file.endsWith('.node'));

  console.log(JSON.stringify({
    nodeVersion: process.versions.node,
    nativeAbi: process.versions.modules,
    execPath: process.execPath,
    addons,
    errors,
    loaded,
  }));
}

smoke().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;


export const workerSource = `
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const requireRuntime = createRequire(path.join(process.argv[2], 'generation/package.json'));
const { Context } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/cordis')).href);
const { WorkerThreadCodeRuntime } = await import(pathToFileURL(
  requireRuntime.resolve('@deepseek-ai/dsh-code-runtime-worker-thread'),
).href);
const context = new Context();

await context.plugin(WorkerThreadCodeRuntime, {});

const codeResult = await context.codeRuntime.run({
  program: 'const value: number = 42; return value;',
  bindings: [],
});
const worker = new Worker(path.join(path.dirname(
  requireRuntime.resolve('@deepseek-ai/dsh-workflow-worker-thread'),
), 'worker.cjs'), {
  workerData: {
    meta: { name: 'bootstrap-probe', description: 'проверка упакованного worker' },
    body: 'return 42;',
    limits: {
      maxConcurrentAgents: 1,
      maxTotalAgents: 1,
      maxItemsPerCall: 1,
      syncTimeoutMs: 5000,
    },
  },
});
const workflow = await new Promise((resolve, reject) => {
  worker.once('error', reject);
  worker.on('message', (message) => {
    if (message.type === 'ready') {
      worker.postMessage({ type: 'go' });
    } else if (message.type === 'result') {
      resolve(message.result);
    }
  });
});

await worker.terminate();
console.log(JSON.stringify({ code: codeResult.value, workflow: workflow.value }));
process.exit(0);
`;


export const ptcWorkerSource = `
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireRuntime = createRequire(path.join(process.argv[2], 'generation/package.json'));
const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const dsh = (name) => load('@deepseek-ai/dsh-' + name);
const { Context } = await load('@deepseek-ai/cordis');
const ctx = new Context();

try {
  for (const name of [
    'session', 'session-projection', 'agent', 'system-prompt', 'fs-local',
    'working-directory', 'subprocess-local', 'sandbox-local',
  ]) {
    await ctx.plugin((await dsh(name)).default, {});
  }

  await ctx.plugin((await dsh('sandbox-policy')).default, {
    mode: 'read-only',
    workspaceRoot: process.cwd(),
  });
  await ctx.plugin((await dsh('ptc-runtime-node')).default, {});
  await ctx.plugin((await dsh('subagent')).default, {});

  const code = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
    program: 'const value: number = 42; value;',
    bindings: [],
  }));

  if (code.error !== undefined) {
    throw new Error(JSON.stringify(code));
  }

  ctx.subagents.registerProvider({
    name: 'probe',
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    start() { throw new Error('Arithmetic workflow must not create any agents'); },
  });
  await ctx.plugin((await dsh('workflow-ptc')).default, { provider: 'probe' });
  const session = ctx.sessions.create(undefined, { meta: { cwd: process.cwd() } });
  const parent = { id: session.id, ctx, session, options: {}, status: 'idle' };

  ctx.agents.register(parent);
  const workflow = ctx.workflowEngine.start({
    script: 'return 6 * 7;',
    meta: { name: 'bootstrap-probe', description: 'Проверка упакованного PTC runtime' },
    parent,
  });

  try {
    const result = await workflow.result;

    if (result.stopReason !== 'completed' || result.agentsStarted !== 0) {
      throw new Error(JSON.stringify(result));
    }

    console.log(JSON.stringify({ code: code.value, workflow: result.value }));
  } finally {
    await workflow.dispose();
  }
} finally {
  await ctx.fiber.dispose();
}
`;
