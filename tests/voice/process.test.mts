import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runWithStdin } from '../../voice/src/process.ts';
import { fixtureRoot } from './helpers.mts';

test('voice-process-доставляет-текст-и-EOF', async () => {
  const reply = await runWithStdin(process.execPath, ['-e', [
    "let text = ''; process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { text += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(text));",
  ].join('\n')], { input: 'з+амок и зам+ок', timeoutMs: 5000 });

  assert.equal(reply.stdout, 'з+амок и зам+ок');
});

test('voice-process-timeout-дожидается-завершения-child', async (t) => {
  const root = await fixtureRoot(t);
  const pidFile = path.join(root, 'child.pid');

  await assert.rejects(runWithStdin(process.execPath, ['-e', [
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n')], { input: '', timeoutMs: 1000 }), /срок|врем|ответил|тайм/iu);

  const pid = Number(await fs.readFile(pidFile, 'utf8'));

  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
