import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { claudeProviderSettingsArgs } from '../../server/src/lib/executors/claude.js';

function hookCommand() {
  const args = claudeProviderSettingsArgs({ blockDirectSsh: true });
  const settingsIndex = args.indexOf('--settings');
  assert.notEqual(settingsIndex, -1, 'Claude не получил server-owned settings');
  const settings = JSON.parse(args[settingsIndex + 1]);
  const groups = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  const hook = groups.flatMap((group) => group?.hooks || [])
    .find((entry) => entry?.type === 'command');
  assert.equal(
    typeof hook?.command,
    'string',
    'в argv Claude нет server-owned PreToolUse для прямого SSH',
  );
  return hook.command;
}

function runHook(input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', hookCommand()], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`SSH policy hook завершился с кодом ${code}: ${stderr}`));
        return;
      }
      const raw = stdout.trim();
      if (!raw) {
        resolve(null);
        return;
      }
      resolve(JSON.parse(raw).hookSpecificOutput?.permissionDecision || null);
    });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function bashRequest(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

test('hook отклоняет SSH-клиенты, wrappers и удалённый rsync', async () => {
  const commands = [
    'ssh prod.example',
    '/usr/bin/slogin prod.example',
    'command scp ./build prod:/srv/build',
    'sudo env sftp prod.example',
    'autossh -M 0 prod.example',
    'ssh-copy-id user@prod.example',
    'sshpass -p secret ssh prod.example',
    'rsync ./build prod:/srv/build',
    'rsync prod:/srv/build ./build',
    'rsync --rsh="ssh -p 2222" ./build ./copy',
    "bash -c 'ssh prod.example'",
    "/bin/sh -lc 'env ssh prod.example'",
  ];
  const decisions = await Promise.all(commands.map((command) => runHook(bashRequest(command))));

  assert.deepEqual(decisions, commands.map(() => 'deny'));
});

test('hook пропускает SSH-утилиты без соединения, локальный rsync, Git и похожие имена', async () => {
  const commands = [
    'ssh-agent -s',
    'ssh-add -l',
    'ssh-keygen -t ed25519',
    'ssh-keyscan prod.example',
    'rsync -a ./from/ ./to/',
    'git push origin main',
    'printf myssh',
    './ssh-helper --version',
  ];
  const decisions = await Promise.all(commands.map((command) => runHook(bashRequest(command))));

  assert.deepEqual(decisions, commands.map(() => null));
});

test('hook отклоняет повреждённый ввод fail-closed', async () => {
  const decisions = await Promise.all([
    runHook('{broken-json'),
    runHook({ tool_name: 'Read', tool_input: { command: 'ssh prod' } }),
    runHook({ tool_name: 'Bash', tool_input: {} }),
  ]);

  assert.deepEqual(decisions, ['deny', 'deny', 'deny']);
});
