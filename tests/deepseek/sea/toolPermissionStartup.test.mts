import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { deepSeekTestArtifactsRoot, ensureTestDeepSeekBinary } from '../../helpers/deepseekBinary.mts';

const execute = promisify(execFile);

test('настоящий host отвергает повреждённую обязательную policy до запуска чата', {
  timeout: 900_000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const directory = await fs.mkdtemp(path.join(deepSeekTestArtifactsRoot(), 'invalid-tool-policy-'));
  const file = path.join(directory, 'policy.json');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(file, JSON.stringify({
    format: 1,
    consumer: 'deepseek-chat',
    revision: 'grigdesk-tool-permissions-v1',
    workspaceRoot: directory,
    workActions: {},
    mode: 'unknown',
  }));

  for (const profile of ['web', 'acp']) {
    for (const args of [
      ['--grigdesk-tool-policy'],
      ['--grigdesk-tool-policy', 'relative.json'],
      ['--grigdesk-tool-policy', file],
    ]) {
      await assert.rejects(execute(candidate.binary, [
        '--cache-dir', candidate.cacheDir, '--profile', profile, ...args,
      ], {
        env: {
          PATH: '',
          HOME: directory,
          DSH_HOME: path.join(directory, 'home'),
        },
        timeout: 30_000,
        maxBuffer: 65_536,
      }), (error: Error & { code?: unknown; stdout?: unknown }) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');

        return true;
      });
    }
  }

  await assert.rejects(fs.stat(path.join(directory, 'home')), { code: 'ENOENT' });
});
