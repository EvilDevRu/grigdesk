import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createInstructionProject } from '../fixtures/deepseek-harness/instructionProject.mts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(REPO_ROOT, 'server/scripts/deepseekInstructionsHook.mts');

function runHook({ root, cwd, payload = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, '--root', root, '--cwd', cwd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout, stderr, value: JSON.parse(stdout.trim()) });
    });
    child.stdin.end(JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      prompt: 'synthetic',
      ...payload,
    }));
  });
}

async function tree(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      entries.push(path.relative(root, file));
      if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
  return entries.sort();
}

test('hook stateless перечитывает импорт на каждый prompt и не создаёт служебных файлов', async (t) => {
  const f = await createInstructionProject(t);
  const before = await tree(f.parent);
  const first = await runHook({ root: f.root, cwd: f.sub });
  const second = await runHook({ root: f.root, cwd: f.sub });
  assert.equal(first.code, 0);
  assert.match(first.value.hookSpecificOutput.additionalContext, /A-V1/u);
  assert.match(second.value.hookSpecificOutput.additionalContext, /A-V1/u);

  await fs.writeFile(path.join(f.docs, 'a.md'), 'A-V2\n@c.md\n');
  const third = await runHook({ root: f.root, cwd: f.sub });
  assert.match(third.value.hookSpecificOutput.additionalContext, /A-V2/u);
  assert.doesNotMatch(third.value.hookSpecificOutput.additionalContext, /A-V1/u);
  assert.deepEqual(await tree(f.parent), before);

  await Promise.all([
    fs.chmod(f.root, 0o555),
    fs.chmod(f.sub, 0o555),
    fs.chmod(f.docs, 0o555),
  ]);
  const readOnly = await runHook({ root: f.root, cwd: f.sub });
  assert.equal(readOnly.code, 0);
  assert.match(readOnly.value.hookSpecificOutput.additionalContext, /A-V2/u);
  await Promise.all([
    fs.chmod(f.root, 0o700),
    fs.chmod(f.sub, 0o700),
    fs.chmod(f.docs, 0o700),
  ]);
});

test('hook при отсутствии git root или повреждённом stdin остаётся fail-open', async (t) => {
  const f = await createInstructionProject(t);
  await fs.rm(path.join(f.root, '.git'), { recursive: true });
  const missing = await runHook({ root: f.root, cwd: f.sub });
  assert.equal(missing.code, 0);
  assert.deepEqual(missing.value, {});
  assert.match(missing.stderr, /корень|\.git/iu);

  const malformed = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, '--root', f.root, '--cwd', f.sub], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end('{broken');
  });
  assert.equal(malformed.code, 0);
  assert.deepEqual(JSON.parse(malformed.stdout), {});
  assert.match(malformed.stderr, /DeepSeek instructions hook/iu);
});
