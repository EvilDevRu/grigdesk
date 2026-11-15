import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runVoice, type VoiceIO } from '../../voice/src/app.ts';
import { localFixture, wavBytes } from './helpers.mts';

for (const engineId of ['piper', 'silero'] as const) {
  test(`voice-cli-${engineId}-install-затем-generate-через-настоящие-границы`, async (t) => {
    const f = await localFixture(t, engineId);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: VoiceIO = {
      env: { GRIGDESK_VOICE_DIR: f.voiceDir },
      getHome: () => f.root,
      readText: (file) => fs.readFile(file, 'utf8'),
      readFile: (file) => fs.readFile(file, 'utf8'),
      writeFile: async (file, bytes) => {
        await fs.writeFile(file, bytes);
      },
      writeStdout: async (value) => {
        stdout.push(String(value));
      },
      writeStderr: async (value) => {
        stderr.push(String(value));
      },
      fetch,
      spawn: f.run,
      scriptPath: f.spec.scriptPath,
      localPackages: [f.pkg],
      bootstrapPython: 'fixture-python3',
    };

    assert.equal(await runVoice(['install', engineId], { version: '0.1.0' }, io), 0);
    stdout.length = 0;
    stderr.length = 0;

    const output = path.join(f.root, 'result.wav');

    assert.equal(await runVoice(['generate', '--engine', engineId,
      '--text', 'проверка связи', '--out', output], { version: '0.1.0' }, io), 0);
    assert.deepEqual(await fs.readFile(output), wavBytes());
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0]!).engine, engineId);
    assert.equal(JSON.parse(stdout[0]!).voice, engineId === 'piper' ? 'irina' : 'xenia');
    assert.deepEqual(stderr, []);
  });
}
