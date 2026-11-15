import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { VoiceError } from '../../voice/src/contract.ts';
import type { SynthesisInput, SynthesisOptions, VoiceEngine } from '../../voice/src/contract.ts';
import { createPiperEngine } from '../../voice/src/engines/piper.ts';
import { createQwenEngine } from '../../voice/src/engines/qwen.ts';
import { createSileroEngine } from '../../voice/src/engines/silero.ts';
import { installLocalEngine } from '../../voice/src/local/install.ts';
import { synthesizePiperFile, synthesizeSileroFile } from '../../voice/src/local/synthesize.ts';
import type { RunProcess } from '../../voice/src/process.ts';
import { buildEngines } from '../../voice/src/registry.ts';
import { fixtureRoot, localFixture, wavBytes } from './helpers.mts';

for (const id of ['qwen', 'piper', 'silero'] as const) {
  test(`voice-${id}-ошибки-пользователя-до-fetch-probe-и-ресурсов`, async () => {
    let effects = 0;
    const forbidden = async (): Promise<never> => {
      effects += 1;

      throw new Error('Запрещённый эффект');
    };
    const engine: VoiceEngine = id === 'qwen'
      ? createQwenEngine({
        apiKey: 'synthetic',
        baseUrl: 'http://127.0.0.1:1',
        fetch: forbidden,
      })
      : id === 'piper'
        ? createPiperEngine({
          voiceRoot: '/missing',
          python: '/missing/python',
          scriptPath: forbidden,
          spawn: forbidden,
        })
        : createSileroEngine({
          engineRoot: '/missing',
          python: '/missing/python',
          scriptPath: forbidden,
          spawn: forbidden,
        });
    const normal: SynthesisInput = {
      text: 'привет',
      voiceRef: null,
      language: 'ru',
    };
    const options: SynthesisOptions = { outputFile: '/never-written.wav' };
    const cases: Array<[SynthesisInput, SynthesisOptions]> = [
      [{ ...normal, voiceRef: 'unknown' }, options],
      [{ ...normal, text: '' }, options],
      [{ ...normal, text: 'а'.repeat(id === 'qwen' ? 601 : 2001) }, options],
      [normal, { ...options, format: 'mp3' }],
    ];

    if (id === 'silero') {
      cases.push([{ ...normal, text: 'API и 2026' }, options]);
    }

    for (const [input, request] of cases) {
      await assert.rejects(engine.synthesize(input, request), (error: unknown) => {
        assert.ok(error instanceof VoiceError);
        assert.equal(error.exitCode, 2);

        return true;
      });
    }

    assert.equal(effects, 0);
  });
}

for (const id of ['piper', 'silero'] as const) {
  test(`voice-${id}-ровно-2000-канонических-символов`, async (t) => {
    const f = await localFixture(t, id);

    await installLocalEngine(f.spec);

    const engine = buildEngines({
      qwenService: 'model-studio',
      qwenApiKey: null,
      qwenBaseUrl: 'http://127.0.0.1:1',
      voiceDir: f.voiceDir,
    }, {
        fetch,
        spawn: f.run,
        scriptPath: f.spec.scriptPath,
      })
      .find((item) => item.id === id)!;

    await engine.synthesize({
      text: 'а'.repeat(2000),
      voiceRef: null,
      language: 'ru',
    },
      { outputFile: path.join(f.root, 'boundary.wav') });
    assert.equal(JSON.parse(await fs.readFile(f.synthLog, 'utf8')).text.length, 2000);
  });

  for (const failure of ['non-wav', 'silence', 'abort'] as const) {
    test(`voice-${id}-${failure}-сохраняет-target-и-убирает-temp`, async (t) => {
      const root = await fixtureRoot(t);
      const output = path.join(root, 'out.wav');
      const controller = new AbortController();

      await fs.writeFile(output, 'previous');

      /**
       * Производитель оставляет WAV или намеренно повреждённый файл в собственном temp.
       * Отмена после записи проверяет границу публикации и уборку ресурса.
       */
      const spawn: RunProcess = async (_command, args) => {
        await fs.writeFile(args[args.indexOf('--out') + 1]!,
          failure === 'non-wav' ? Buffer.alloc(46) : wavBytes());

        if (failure === 'abort') {
          controller.abort();
        }

        return { stdout: JSON.stringify({ peak: failure === 'silence' ? 0 : 0.5 }), stderr: '' };
      };
      const common = {
        python: '/fixture/python',
        scriptPath: '/fixture/script.py',
        modelFile: '/fixture/model',
        outputFile: output,
        text: 'привет',
        signal: controller.signal,
        spawn,
      };
      const operation = id === 'piper'
        ? synthesizePiperFile({ ...common, configFile: '/fixture/config' })
        : synthesizeSileroFile({ ...common, speaker: 'xenia' });

      await assert.rejects(operation, failure === 'abort' ? /отменена/u
        : failure === 'silence' ? /тишину/u : /WAV/u);
      assert.equal(await fs.readFile(output, 'utf8'), 'previous');
      assert.deepEqual(await fs.readdir(root), ['out.wav']);
    });
  }
}

test('voice-qwen-неверный-json-не-повторяет-POST-и-сохраняет-файл', async (t) => {
  const root = await fixtureRoot(t);
  const output = path.join(root, 'out.wav');
  let requests = 0;

  await fs.writeFile(output, 'previous');

  const engine = createQwenEngine({
    apiKey: 'synthetic',
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      requests += 1;

      return new Response('{', { status: 200 });
    },
  });

  await assert.rejects(engine.synthesize({
    text: 'привет',
    voiceRef: null,
    language: null,
  },
    { outputFile: output }), /Не удалось получить речь/u);
  assert.equal(requests, 1);
  assert.equal(await fs.readFile(output, 'utf8'), 'previous');
  assert.deepEqual(await fs.readdir(root), ['out.wav']);
});
