import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { helperCommand } from '../../server/src/lib/runtimePaths.ts';
import { bundlePayloadServer } from '../../server/scripts/sea/bundle.mts';
import { buildHelper } from '../../server/scripts/sea/helpers.mts';

const SOURCE = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Запускает именно hook protocol и ждёт close после сбора обоих потоков.
 * Срок и cleanup относятся только к созданному ребёнку, окружение не наследует ключи.
 */
async function invokeHook(t, spec, payload) {
  const child = spawn(spec.command, spec.args, {
    env: { PATH: '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = {
    stdout: '',
    stderr: '',
  };

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value) => {
    output.stdout += value;
  });
  child.stderr.on('data', (value) => {
    output.stderr += value;
  });

  const code = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  child.stdin.end(JSON.stringify(payload));

  const exitCode = await code;

  return { ...output, code: exitCode };
}

test('SB-HOOK: instructions и GLM hooks действительно выполняют работу', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-hook-test-'));
  const cwd = path.join(root, 'project with spaces');
  const policyFile = path.join(root, 'policy.json');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd);
  await writeFile(path.join(cwd, 'CLAUDE.md'), '@fixture.md\n');
  await writeFile(path.join(cwd, 'fixture.md'), 'server-hook-fixture-marker\n');
  await writeFile(policyFile, JSON.stringify({
    workTools: [],
    ssh: true,
    db: true,
    strictDb: true,
  }));

  const instructions = helperCommand('deepseek-instructions-hook', ['--root', cwd, '--cwd', cwd]);
  const context = await invokeHook(t, instructions, { hook_event_name: 'UserPromptSubmit' });

  assert.equal(context.code, 0);
  assert.match(JSON.parse(context.stdout).hookSpecificOutput.additionalContext, /server-hook-fixture-marker/);

  const glm = helperCommand('glm-tool-policy-hook', ['--policy', policyFile]);
  const alive = await invokeHook(t, glm, { hook_event_name: 'UserPromptSubmit' });

  assert.equal(alive.code, 0);
  assert.match(alive.stderr, /hooks-alive/);

  const denied = await invokeHook(t, glm, {
    hook_event_name: 'PreToolUse',
    tool_name: 'bash',
    tool_use_id: 'fixture-call',
    tool_input: { command: 'ssh fixture-host' },
  });

  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /deny|запрещ/u);
});

test('SB-HOOK: команды profiles из payload выполняют собранные hooks с кавычками в путях',
  { timeout: 15_000 }, async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), "server-hooks 'quote-"));
    const root = path.join(base, 'R with spaces');
    const project = path.join(base, "project's files");
    const helpers = path.join(root, 'server/runtime/helpers');
    const binary = path.join(base, 'bin/grigdesk-server');
    const manifestPath = path.join(SOURCE, 'server/build/helpers.json');
    const outfile = path.join(root, 'server/payload.cjs');

    t.after(() => rm(base, { recursive: true, force: true }));
    await mkdir(helpers, { recursive: true });
    await mkdir(project);
    await mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
    await mkdir(path.dirname(binary));
    await writeFile(binary, 'ELF');
    await symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));
    await writeFile(path.join(helpers, 'helpers.json'), await readFile(manifestPath));
    await writeFile(path.join(project, 'CLAUDE.md'), '@fixture.md\n');
    await writeFile(path.join(project, 'fixture.md'), 'server-hook-fixture-marker\n');

    for (const id of ['deepseek-instructions-hook', 'glm-tool-policy-hook', 'direct-ssh-policy-hook']) {
      await buildHelper({
        root: SOURCE,
        manifestPath,
        id,
        outDir: helpers,
        workDir: path.join(base, 'build'),
      });
    }

    const common = {
      cwd: project,
      workspaceRoot: project,
      transport: 'web',
    };
    const deepseek = {
      ...common,
      launchDir: path.join(base, 'deepseek'),
      mode: 'workspace-write',
      approval: 'ask',
      hooks: {
        bashToolName: 'bash',
        ssh: true,
        db: true,
        strictDb: true,
        instructions: { projectRoot: project },
      },
    };
    const glm = {
      ...common,
      transport: 'acp',
      launchDir: path.join(base, 'glm'),
      projectRoot: project,
      accessMode: 'api',
      model: 'glm-fixture',
      settingsDocument: path.join(base, 'settings.yaml'),
      hooks: {
        ssh: true,
        db: true,
        strictDb: true,
      },
    };

    await bundlePayloadServer({
      sourceRoot: SOURCE,
      workDir: path.join(base, 'build'),
      outfile,
      plugins: [{
        name: 'fixture-profiles',
        setup(builder) {
          builder.onLoad({ filter: /server\/src\/app\.ts$/ }, () => ({
            contents: [
              'import { readFile } from "node:fs/promises";',
              'import { buildLaunchFiles } from "./lib/deepseek/profile.ts";',
              'import { buildGlmLaunchFiles } from "./lib/glm/profile.ts";',
              `Promise.all([buildLaunchFiles(${JSON.stringify(deepseek)}),`,
              `  buildGlmLaunchFiles(${JSON.stringify(glm)})]).then(async (files) => {`,
              '  const hooks = await Promise.all(files.map(async (file) =>',
              '    JSON.parse(await readFile(file.hooksPath, "utf8"))));',
              '  process.stdout.write(JSON.stringify(hooks));',
              '}).catch((error) => { console.error(error); process.exitCode = 1; });',
            ].join('\n'),
            resolveDir: path.join(SOURCE, 'server/src'),
            loader: 'ts',
          }));
        },
      }],
    });

    const driver = 'require(process.argv[1]).startPayloadServer(process.argv[2]);';
    const output = execFileSync(process.execPath, ['-e', driver, outfile, binary], {
      env: { PATH: '' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    const [deepseekHooks, glmHooks] = JSON.parse(output);
    const instruction = deepseekHooks.hooks.UserPromptSubmit[0].hooks[0].command;
    const policy = glmHooks.hooks.UserPromptSubmit[0].hooks[1].command;
    const context = await invokeHook(t, { command: 'bash', args: ['-c', instruction] }, {
      hook_event_name: 'UserPromptSubmit',
    });

    assert.equal(context.code, 0, context.stderr);

    const additionalContext = JSON.parse(context.stdout).hookSpecificOutput.additionalContext;

    assert.match(additionalContext, /server-hook-fixture-marker/);

    const alive = await invokeHook(t, { command: 'bash', args: ['-c', policy] }, {
      hook_event_name: 'UserPromptSubmit',
    });
    const denied = await invokeHook(t, { command: 'bash', args: ['-c', policy] }, {
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
      tool_use_id: 'fixture-call',
      tool_input: { command: 'ssh fixture-host' },
    });

    assert.equal(alive.code, 0, alive.stderr);
    assert.match(alive.stderr, /hooks-alive/);
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /deny|запрещ/u);
  });
