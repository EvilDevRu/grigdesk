import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { environment, tracked, within } from './common.mts';

const execute = promisify(execFile);
const root = process.argv[2]!;
const node = path.join(root, 'runtime/node/bin/node');
const helper = (id: string) => path.join(root, 'server/runtime/helpers', `${id}.mjs`);
const env = environment();

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

const options = {
  cwd: '/D',
  env,
  timeout: 30000,
};
const engine = await execute(path.join(root, 'engine/bin/factory'), [
  'capabilities', '--format', 'json',
], options);

assert.ok(JSON.parse(engine.stdout).features.includes('native-subcommands'));

const help = await execute(path.join(root, 'bin/grigdesk-ctl'), ['--help'], options);
const version = await execute(path.join(root, 'bin/grigdesk-ctl'), ['--version'], options);

assert.match(help.stdout, /grigdesk-ctl/);
assert.match(version.stdout, /GrigDesk \d/);
console.log(JSON.stringify({
  supervisor: true,
  peerAlive: true,
  engine: true,
  cli: true,
}));
