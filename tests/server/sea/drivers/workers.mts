import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { makeGlb } from '../../helpers/studio3dGlb.js';
import { environment, tracked, within } from './common.mts';

const execute = promisify(execFile);
const root = process.argv[2]!;
const node = path.join(root, 'runtime/node/bin/node');
const helper = (id: string) => path.join(root, 'server/runtime/helpers', `${id}.mjs`);
const env = environment();

await mkdir('/D/helper-work', { recursive: true });
await writeFile('/D/helper-work/source.glb', makeGlb({ triangles: 2, size: [1, 2, 1] }));

const source = await open('/D/helper-work/source.glb', 'r');
const directory = await open('/D/helper-work', 'r');
const analysis = spawn(node, [helper('studio3d-analysis-worker'), JSON.stringify({
  operation: 'rewrite',
  sourcePath: '/D/helper-work/source.glb',
  outputDirectory: '/D/helper-work',
  outputName: 'result.glb',
  wrap: { scale: 2 },
})], {
  cwd: '/D',
  env,
  stdio: ['ignore', 'pipe', 'pipe', source.fd, directory.fd],
});
let output = '';
let errors = '';

analysis.stdout!.on('data', (chunk: Buffer) => {
  output += chunk.toString();
});
analysis.stderr!.on('data', (chunk: Buffer) => {
  errors += chunk.toString();
});

try {
  assert.equal((await within(once(analysis, 'close'), 20000))[0], 0, errors);
  assert.equal(JSON.parse(output).ok, true, output);
  assert.deepEqual(JSON.parse(output).stats.size, [2, 4, 2]);
  assert.equal((await readFile('/D/helper-work/result.glb')).readUInt32LE(0), 0x46546c67);
} finally {
  if (analysis.exitCode === null && analysis.signalCode === null) {
    analysis.kill('SIGKILL');
  }

  await source.close();
  await directory.close();
}

const peer = tracked(node, ['-e', 'setInterval(() => {}, 1000)'], env);
const supervisor = tracked(node, [helper('plugin-command-supervisor')], env, true);
let leader = 0;

supervisor.child.on('message', (message: { type: string; worker: { pid: number } }) => {
  if (message.type === 'worker') {
    leader = message.worker.pid;
    supervisor.child.send({
      type: 'ack',
      command: {
        file: node,
        args: ['-e', "require('fs').writeFileSync('/D/target-started', String(process.pid));"
          + 'setInterval(() => {}, 1000)'],
        cwd: '/D',
        env,
      },
    });
  }
});
supervisor.child.send({ type: 'start', commandId: 'sea-fixture' });

try {
  const deadline = Date.now() + 10000;
  let started = '';

  while (Date.now() < deadline && !started) {
    started = await readFile('/D/target-started', 'utf8').catch(() => '');

    if (!started) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  assert.ok(started, supervisor.log());
  assert.ok(leader > 0);
  supervisor.child.disconnect();
  assert.equal((await within(supervisor.exited, 10000)).code, 0, supervisor.log());

  for (const pid of [leader, Number(started)]) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');

    assert.ok(!stat || stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z'),
      `Остался живой потомок ${pid}`);
  }

  assert.equal(peer.finished(), false, peer.log());
} finally {
  await supervisor.stop();
  await peer.stop();
}

await mkdir('/D/engine-run', { recursive: true });
await writeFile('/D/engine-run/meta.env', 'SOURCE=runtime\n');
await writeFile('/D/engine-run/events.jsonl', JSON.stringify({
  type: 'turn.failed',
  error: { code: '401', message: 'authentication required' },
}) + '\n');
await writeFile('/D/prepared.json', JSON.stringify({
  normalization: { provider: 'codex', normalizerDialect: 'codex-json' },
}));

const engine = await execute('/bin/bash', ['-c', [
  'source "$FACTORY_HOME/lib/runner-launcher.sh"',
  'source "$FACTORY_HOME/lib/runners/codex.sh"',
  'runner_codex_classify /D/engine-run 1',
  'exec {RUNNER_RUNTIME_RUN_DIR_FD}</D/engine-run',
  '_runner_runtime_usage_call invalidate /D/prepared.json fixtureConflict',
].join('\n')], {
  cwd: '/D',
  env: {
    ...env,
    FACTORY_HOME: path.join(root, 'engine'),
    NODE_BIN: node,
  },
  timeout: 20000,
});
const lines = engine.stdout.trim().split('\n');

assert.equal(lines[0], 'provider_unavailable');
assert.equal(JSON.parse(lines[1]!).normalization.completeness, 'conflict');

const options = {
  cwd: '/D',
  env,
  timeout: 30000,
};
const help = await execute(path.join(root, 'bin/grigdesk-ctl'), ['--help'], options);
const version = await execute(path.join(root, 'bin/grigdesk-ctl'), ['--version'], options);

assert.match(help.stdout, /grigdesk-ctl/);
assert.match(version.stdout, /GrigDesk \d/);
console.log(JSON.stringify({
  glb: true,
  supervisor: true,
  peerAlive: true,
  engine: true,
  cli: true,
}));
