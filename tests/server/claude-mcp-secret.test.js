import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import claude from '../../server/src/lib/executors/claude.js';

test('internal permission capability не попадает в argv Claude и удаляется после хода', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-mcp-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakeCli = path.join(dir, 'fake-claude.cjs');
  const observed = path.join(dir, 'observed.json');
  const secret = 'internal-capability-must-not-be-in-argv';

  await writeFile(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const index = args.indexOf('--mcp-config');
const configPath = index >= 0 ? args[index + 1] : '';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.writeFileSync(process.env.OBSERVED_ARGS, JSON.stringify({
  args,
  configPath,
  mode: fs.statSync(configPath).mode & 0o777,
  token: config.mcpServers.perm.env.COCKPIT_INTERNAL,
}));
process.stdout.write(JSON.stringify({
  type: 'result',
  result: 'ok',
  session_id: 'session-1',
  usage: {},
  num_turns: 1,
}) + '\\n');
`, { mode: 0o700 });
  await chmod(fakeCli, 0o700);

  const result = await claude.run({
    config: { claudeBin: fakeCli },
    env: { ...process.env, OBSERVED_ARGS: observed },
    message: 'hello',
    cwd: dir,
    permissionMode: 'default',
    mcpConfig: {
      mcpServers: {
        perm: {
          command: process.execPath,
          args: ['/tmp/permission-mcp.js'],
          env: { COCKPIT_INTERNAL: secret },
        },
      },
    },
    permissionPromptTool: 'mcp__perm__approve',
  });

  assert.equal(result.reply, 'ok');
  const capture = JSON.parse(await readFile(observed, 'utf8'));
  assert.equal(capture.token, secret);
  assert.equal(capture.mode, 0o600);
  assert.ok(path.isAbsolute(capture.configPath));
  assert.equal(capture.args.join(' ').includes(secret), false);
  await assert.rejects(access(capture.configPath), { code: 'ENOENT' });
});
