import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmod, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import claude from '../../server/src/lib/executors/claude.js';
import codex from '../../server/src/lib/executors/codex.js';

test('Claude и Codex объявляют проверяемый scoped workspace для триажа', () => {
  assert.deepEqual({
    claude: claude.scopedWorkspace,
    codex: typeof codex.scopedWorkspace,
  }, {
    claude: true,
    codex: 'function',
  });
});

test('Claude читает repo/input, но писать разрешает только в output без общего Bash', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-scoped-workspace-'));
  const repo = path.join(root, 'repo');
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const trace = path.join(root, 'argv.txt');
  const bin = path.join(root, 'fake-claude');
  await Promise.all([
    mkdir(repo),
    mkdir(input),
    mkdir(output),
  ]);
  await writeFile(bin, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "$COCKPIT_SCOPED_TRACE"',
    'printf \'%s\\n\' \'{"type":"result","subtype":"success","result":"ok","session_id":"scoped"}\'',
  ].join('\n'));
  await chmod(bin, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));

  await claude.run({
    config: { claudeBin: bin },
    env: { ...process.env, COCKPIT_SCOPED_TRACE: trace },
    message: 'Оцени задачу',
    cwd: output,
    model: 'claude-opus-5',
    effort: 'high',
    sessionId: null,
    permissionMode: 'acceptEdits',
    providerSettings: {},
    workspaceAccess: {
      readableRoots: [repo, input, output],
      writableRoots: [output],
      networkAccess: false,
      allowExternalMcp: false,
      allowBash: false,
      tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'repo_history'],
    },
  });
  const argv = (await readFile(trace, 'utf8')).split('\n');
  const settingsAt = argv.lastIndexOf('--settings');
  const settings = JSON.parse(argv[settingsAt + 1]);
  const allow = settings.permissions?.allow || [];
  const deny = settings.permissions?.deny || [];

  assert.deepEqual({
    readRoots: [repo, input].map((rootPath) => (
      argv.some((value, index) => value === rootPath && argv[index - 1] === '--add-dir')
    )),
    outputWrite: allow.some((rule) => rule.includes('Write') && rule.includes(output)),
    protectedWrite: [repo, input].map((rootPath) => (
      deny.some((rule) => rule.includes('Write') && rule.includes(rootPath))
    )),
    scopedRead: [repo, input, output].map((rootPath) => (
      allow.some((rule) => rule.startsWith('Read') && rule.includes(rootPath))
    )),
    globalRead: allow.includes('Read(//**)'),
    bashAllowed: allow.some((rule) => rule.startsWith('Bash')),
    builtInTools: argv[argv.indexOf('--tools') + 1],
    strictMcp: argv.includes('--strict-mcp-config'),
    settingsSources: argv[argv.indexOf('--setting-sources') + 1],
  }, {
    readRoots: [true, true],
    outputWrite: true,
    protectedWrite: [true, true],
    scopedRead: [true, true, true],
    globalRead: false,
    bashAllowed: false,
    builtInTools: 'Read,Glob,Grep,Write,Edit',
    strictMcp: true,
    settingsSources: '',
  });
});
