import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEEPSEEK_BASH_TOOL, DEEPSEEK_PIN } from '../../server/src/lib/deepseek/contract.ts';
import { buildLaunchFiles } from '../../server/src/lib/deepseek/profile.ts';
import { DIRECT_SSH_HOOK_PATH } from '../../server/src/lib/executors/_directSshPolicy.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/profile');
const INSTRUCTIONS_HOOK = fileURLToPath(new URL(
  '../../server/scripts/deepseekInstructionsHook.mts',
  import.meta.url,
));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-deepseek-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launchDir = path.join(root, 'launch');
  const cwd = path.join(root, 'project with spaces', 'sub');
  const projectRoot = path.dirname(cwd);
  await fs.mkdir(cwd, { recursive: true });
  return { root, launchDir, cwd, projectRoot };
}

async function golden(file, replacements) {
  let value = await fs.readFile(path.join(FIXTURES, file), 'utf8');
  for (const [token, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`{{${token}}}`, replacement);
  }
  return value;
}

test('profile builder пишет точные overlay/hooks, приватные modes и стабильный fingerprint', async (t) => {
  const f = await fixture(t);
  const options = {
    launchDir: f.launchDir,
    cwd: f.cwd,
    workspaceRoot: f.cwd,
    mode: 'workspace-write',
    approval: 'ask',
    hooks: {
      bashToolName: DEEPSEEK_BASH_TOOL,
      ssh: true,
      db: true,
      strictDb: true,
      instructions: { projectRoot: f.projectRoot },
    },
  };
  const first = await buildLaunchFiles(options);
  const second = await buildLaunchFiles(options);
  const hooksPath = path.join(f.launchDir, 'hooks.json');
  const overlay = await fs.readFile(first.overlayPath, 'utf8');
  const hooks = await fs.readFile(hooksPath, 'utf8');

  assert.equal(overlay, await golden('overlay.yml', {
    CWD: f.cwd.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
    HOOKS_PATH: hooksPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
  }));
  assert.equal(hooks, await golden('hooks.json', {
    NODE: shellQuote(process.execPath),
    POLICY_HOOK: shellQuote(DIRECT_SSH_HOOK_PATH),
    BASH_TOOL: shellQuote(DEEPSEEK_BASH_TOOL),
    INSTRUCTIONS_HOOK: shellQuote(INSTRUCTIONS_HOOK),
    PROJECT_ROOT: shellQuote(f.projectRoot),
    CWD: shellQuote(f.cwd),
  }));
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(first.version, DEEPSEEK_PIN.version);
  assert.equal((await fs.stat(f.launchDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(first.overlayPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(hooksPath)).mode & 0o777, 0o600);
});

test('profile builder записывает переданный workspaceRoot в sandbox-policy', async (t) => {
  const f = await fixture(t);
  const result = await buildLaunchFiles({
    launchDir: f.launchDir,
    cwd: f.cwd,
    workspaceRoot: f.projectRoot,
    mode: 'workspace-write',
    approval: 'ask',
    hooks: {
      bashToolName: DEEPSEEK_BASH_TOOL,
      ssh: false,
      db: false,
      strictDb: false,
      instructions: { projectRoot: f.projectRoot },
    },
  });
  const overlay = await fs.readFile(result.overlayPath, 'utf8');
  const policyLine = overlay.split('\n').find((line) => line.trimStart().startsWith('workspaceRoot:'));
  assert.equal(policyLine?.trim(), `workspaceRoot: ${JSON.stringify(f.projectRoot)}`);
});

test('profile builder убирает PreToolUse, если обе command-policy выключены', async (t) => {
  const f = await fixture(t);
  const result = await buildLaunchFiles({
    launchDir: f.launchDir,
    cwd: f.cwd,
    workspaceRoot: f.cwd,
    mode: 'read-only',
    approval: 'never',
    hooks: {
      bashToolName: DEEPSEEK_BASH_TOOL,
      ssh: false,
      db: false,
      strictDb: false,
      instructions: { projectRoot: f.projectRoot },
    },
  });
  const parsed = JSON.parse(await fs.readFile(result.hooksPath, 'utf8'));
  assert.equal('PreToolUse' in parsed.hooks, false);
  assert.equal(parsed.hooks.UserPromptSubmit.length, 1);
  assert.match(await fs.readFile(result.overlayPath, 'utf8'), /mode: "read-only"/u);
  assert.match(await fs.readFile(result.overlayPath, 'utf8'), /policy: "never"/u);
  assert.match(
    await fs.readFile(result.overlayPath, 'utf8'),
    /factory-state-only:[\s\S]*sandbox: "read-only"[\s\S]*approval: "never"[\s\S]*defaultPreset: "factory-state-only"/u,
  );
});

test('profile builder отклоняет относительные пути и значения вне контракта', async (t) => {
  const f = await fixture(t);
  const valid = {
    launchDir: f.launchDir,
    cwd: f.cwd,
    workspaceRoot: f.cwd,
    mode: 'workspace-write',
    approval: 'ask',
    hooks: {
      bashToolName: DEEPSEEK_BASH_TOOL,
      ssh: true,
      db: false,
      strictDb: false,
      instructions: { projectRoot: f.projectRoot },
    },
  };
  await assert.rejects(buildLaunchFiles({ ...valid, cwd: 'relative' }), /абсолют/u);
  await assert.rejects(buildLaunchFiles({ ...valid, workspaceRoot: undefined }), TypeError);
  await assert.rejects(buildLaunchFiles({ ...valid, workspaceRoot: 'relative' }), TypeError);
  await assert.rejects(buildLaunchFiles({ ...valid, workspaceRoot: path.join(f.root, 'other') }), TypeError);
  await assert.rejects(buildLaunchFiles({ ...valid, workspaceRoot: f.cwd + '-sibling' }), TypeError);
  await assert.rejects(buildLaunchFiles({ ...valid, mode: 'danger-full-access' }), /mode/u);
  await assert.rejects(buildLaunchFiles({ ...valid, approval: 'always' }), /approval/u);
  await assert.rejects(buildLaunchFiles({
    ...valid,
    hooks: { ...valid.hooks, bashToolName: 'Bash' },
  }), /bashToolName/u);
});
