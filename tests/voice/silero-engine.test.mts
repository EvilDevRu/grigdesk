import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSileroEngine } from '../../voice/src/engines/silero.ts';
import { unreadableFragments } from '../../voice/src/contract.ts';

/**
 * Поддельный python silero: сохраняет stdin и argv в файлы (контракт спавна),
 * пишет wav-заглушку и печатает факты с нормальным пиком.
 */
function fakePython(dir: string): {
  python: string;
  stdinFile: string;
  argvFile: string;
} {
  const stdinFile = path.join(dir, 'stdin.txt');
  const argvFile = path.join(dir, 'argv.json');
  const file = path.join(dir, 'python');

  writeFileSync(
    file,
    [
      '#!/usr/bin/env python3',
      'import json, sys, wave, struct',
      'args = sys.argv[1:]',
      'if args and args[0] == "-c": sys.exit(0)',
      'out = args[args.index("--out") + 1]',
      `open(${JSON.stringify(stdinFile)}, "w").write(sys.stdin.read())`,
      `open(${JSON.stringify(argvFile)}, "w").write(json.dumps(args))`,
      'with wave.open(out, "wb") as audio:',
      '    audio.setparams((1, 2, 48000, 0, "NONE", "not compressed"))',
      '    audio.writeframes(struct.pack("<h", 1000) * 1002)',
      'print(json.dumps({"durationMs": 1200, "sampleRate": 48000, "channels": 1, "peak": 0.4}))',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  return {
    python: file,
    stdinFile,
    argvFile,
  };
}

/**
 * Создаёт модель и согласованный манифест с двумя дикторами.
 * Пустышка модели позволяет проверить пути без установки torch.
 */
function installedRoot(t: Pick<import('node:test').TestContext, 'after'>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-silero-'));
  const modelDir = path.join(dir, 'engines', 'silero', 'models', 'v5_5_ru');

  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    path.join(modelDir, 'voice.json'),
    JSON.stringify({
      id: 'v5_5_ru',
      name: 'Silero v5.5',
      language: 'ru',
      sampleRate: 48000,
      file: 'v5_5_ru.pt',
      speakers: [
        {
          id: 'xenia',
          name: 'Ксения',
          timbre: 'женский',
        },
        {
          id: 'aidar',
          name: 'Айдар',
          timbre: 'мужской',
        },
      ],
    }),
  );
  writeFileSync(path.join(modelDir, 'v5_5_ru.pt'), 'torch-model');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

test('voice-silero-unreadable-находит-обрывки', () => {
  assert.deepEqual(
    unreadableFragments('звоним по API в 2026 году', ['latin', 'digits']),
    ['API', '2026'],
  );
  assert.deepEqual(unreadableFragments('чистый текст', ['latin', 'digits']), []);
});

test('voice-silero-voices-из-манифеста', async (t) => {
  const dir = installedRoot(t);
  const fake = fakePython(dir);
  const engine = createSileroEngine({
    engineRoot: path.join(dir, 'engines', 'silero'),
    python: fake.python,
    scriptPath: path.join(dir, 'sileroSynth.py'),
  });
  const voices = await engine.voices();

  assert.equal(voices.length, 2);
  assert.ok(voices[0]);
  assert.equal(voices[0].id, 'xenia');
});

test('voice-silero-stdin-содержит-ударения-и-без-ssml-обёртки', async (t) => {
  const dir = installedRoot(t);
  const fake = fakePython(dir);
  const engine = createSileroEngine({
    engineRoot: path.join(dir, 'engines', 'silero'),
    python: fake.python,
    scriptPath: path.join(dir, 'sileroSynth.py'),
  });
  const out = path.join(dir, 'out.wav');
  const result = await engine.synthesize(
    {
      text: 'з+амок и зам+ок',
      voiceRef: 'xenia',
      language: 'ru',
    },
    { outputFile: out, pace: 'normal' },
  );
  const { readFile } = await import('node:fs/promises');
  const stdin = await readFile(fake.stdinFile, 'utf8');

  assert.match(stdin, /з\+амок/u);
  assert.match(stdin, /зам\+ок/u);
  assert.doesNotMatch(stdin, /<speak>/u, 'обёртку строит скрипт, а не адаптер');
  assert.deepEqual(result.ignoredDirections, []);
});

test('voice-silero-латиница-отказ-до-запуска', async (t) => {
  const dir = installedRoot(t);
  const fake = fakePython(dir);
  const engine = createSileroEngine({
    engineRoot: path.join(dir, 'engines', 'silero'),
    python: fake.python,
    scriptPath: path.join(dir, 'sileroSynth.py'),
  });

  await assert.rejects(
    engine.synthesize(
      {
        text: 'звоним по API',
        voiceRef: 'xenia',
        language: 'ru',
      },
      { outputFile: path.join(dir, 'never.wav'), pace: 'normal' },
    ),
    (error: Error) => {
      assert.match(error.message, /API/u);

      return true;
    },
  );
  await assert.rejects(
    (await import('node:fs/promises')).access(fake.argvFile),
    { code: 'ENOENT' },
    'python не запускался при непечатаемом тексте',
  );
});

test('voice-silero-темп-передаётся-скрипту', async (t) => {
  const dir = installedRoot(t);
  const fake = fakePython(dir);
  const engine = createSileroEngine({
    engineRoot: path.join(dir, 'engines', 'silero'),
    python: fake.python,
    scriptPath: path.join(dir, 'sileroSynth.py'),
  });
  const out = path.join(dir, 'out.wav');
  const result = await engine.synthesize(
    {
      text: 'привет',
      voiceRef: 'xenia',
      language: 'ru',
    },
    { outputFile: out, pace: 'fast' },
  );
  const { readFile } = await import('node:fs/promises');
  const argv = JSON.parse(await readFile(fake.argvFile, 'utf8')) as string[];

  assert.equal(argv[argv.indexOf('--rate') + 1], 'fast');
  assert.equal(
    argv[argv.indexOf('--model') + 1],
    path.join(dir, 'engines', 'silero', 'models', 'v5_5_ru', 'v5_5_ru.pt'),
  );
  assert.equal(argv[argv.indexOf('--speaker') + 1], 'xenia');
  assert.deepEqual(result.ignoredDirections, [], 'темп поддержан и применён');
});

test('voice-silero-длинный-текст-отказ-до-запуска', async (t) => {
  const dir = installedRoot(t);
  const fake = fakePython(dir);
  const engine = createSileroEngine({
    engineRoot: path.join(dir, 'engines', 'silero'),
    python: fake.python,
    scriptPath: path.join(dir, 'sileroSynth.py'),
  });

  await assert.rejects(
    engine.synthesize(
      {
        text: 'а'.repeat(2001),
        voiceRef: 'xenia',
        language: 'ru',
      },
      { outputFile: path.join(dir, 'long.wav'), pace: 'normal' },
    ),
    /длиннее предела/u,
  );
  await assert.rejects(
    (await import('node:fs/promises')).access(fake.argvFile),
    { code: 'ENOENT' },
    'python не запускался при превышении лимита',
  );
});
