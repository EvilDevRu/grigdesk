import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPiperEngine } from '../../voice/src/engines/piper.ts';

/**
 * Поддельный python: сохраняет stdin и argv в файлы (проверка контракта спавна),
 * пишет wav-заглушку по --out и печатает строку JSON с фактами.
 */
function fakePython(dir: string, peak: number): {
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
      '    audio.setparams((1, 2, 22050, 0, "NONE", "not compressed"))',
      '    audio.writeframes(struct.pack("<h", 1000) * 490)',
      `print(json.dumps({"durationMs": 800, "sampleRate": 22050, "channels": 1, "peak": ${peak}}))`,
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
 * Готовит каталог данных с установленной Ириной и возвращает корень и поддельный python.
 * Настоящие модель и зависимости движка для проверки протокола не нужны.
 */
function installedRoot(
  t: Pick<import('node:test').TestContext, 'after'>,
  peak: number,
): ReturnType<typeof fakePython> & { dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-piper-'));
  const voiceDir = path.join(dir, 'engines', 'piper', 'voices', 'irina');

  mkdirSync(voiceDir, { recursive: true });
  writeFileSync(
    path.join(voiceDir, 'voice.json'),
    JSON.stringify({
      id: 'irina',
      name: 'Ирина',
      language: 'ru',
      timbre: 'женский',
      model: 'ru-irinia-medium.onnx',
      config: 'ru-irinia-medium.onnx.json',
      sampleRate: 22050,
    }),
  );
  writeFileSync(path.join(voiceDir, 'ru-irinia-medium.onnx'), 'model');
  writeFileSync(path.join(voiceDir, 'ru-irinia-medium.onnx.json'), 'config');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return { dir, ...fakePython(dir, peak) };
}

function engineOf(root: { dir: string; python: string }) {
  return createPiperEngine({
    voiceRoot: path.join(root.dir, 'engines', 'piper'),
    python: root.python,
    scriptPath: path.join(root.dir, 'piperSynth.py'),
  });
}

test('voice-piper-doctor-без-установки-заблокирован', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'voice-piper-empty-'));
  const engine = createPiperEngine({
    voiceRoot: path.join(empty, 'engines', 'piper'),
    python: null,
    scriptPath: path.join(empty, 'piperSynth.py'),
  });

  try {
    const doctor = await engine.doctor();

    assert.equal(doctor.status, 'blocked');
    assert.match(doctor.install, /voice install piper/u);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('voice-piper-voices-из-манифеста', async (t) => {
  const root = installedRoot(t, 0.5);
  const voices = await engineOf(root).voices();

  assert.equal(voices.length, 1);
  assert.ok(voices[0]);
  assert.equal(voices[0].name, 'Ирина (женский)');
  assert.equal(voices[0].available, true);
});

test('voice-piper-synthesize-передаёт-контракт-спавна', async (t) => {
  const root = installedRoot(t, 0.5);
  const out = path.join(root.dir, 'out.wav');
  const result = await engineOf(root).synthesize(
    {
      text: 'привет',
      voiceRef: 'irina',
      language: 'ru',
    },
    { outputFile: out, pace: 'slow' },
  );
  const { readFile, stat } = await import('node:fs/promises');
  const stdin = await readFile(root.stdinFile, 'utf8');
  const argv = JSON.parse(await readFile(root.argvFile, 'utf8')) as string[];
  const voiceDir = path.join(root.dir, 'engines', 'piper', 'voices', 'irina');

  assert.equal(stdin, 'привет');
  assert.ok(argv.includes('--model'), 'передан --model');
  assert.equal(argv[argv.indexOf('--model') + 1], path.join(voiceDir, 'ru-irinia-medium.onnx'));
  assert.equal(argv[argv.indexOf('--config') + 1], path.join(voiceDir, 'ru-irinia-medium.onnx.json'));
  assert.equal(argv[argv.indexOf('--length-scale') + 1], '1.15', 'slow = 1.15');
  assert.equal((await stat(out)).size, 1024, 'файл со speech-заглушкой записан');
  assert.equal(result.format, 'wav');
  assert.deepEqual(result.ignoredDirections, []);
});

test('voice-piper-ударения-снимаются-и-честно-игнорируются', async (t) => {
  const root = installedRoot(t, 0.5);
  const out = path.join(root.dir, 'out.wav');
  const result = await engineOf(root).synthesize(
    {
      text: 'з+амок',
      voiceRef: 'irina',
      language: 'ru',
    },
    { outputFile: out, pace: 'normal' },
  );
  const stdin = await (await import('node:fs/promises')).readFile(root.stdinFile, 'utf8');

  assert.equal(stdin, 'замок', 'движок получил канонический текст без +');
  assert.deepEqual(result.ignoredDirections, ['ударения']);
});

test('voice-piper-тишина-вместо-речи-отказ', async (t) => {
  const root = installedRoot(t, 0.001);

  await assert.rejects(
    engineOf(root).synthesize(
      {
        text: 'привет',
        voiceRef: 'irina',
        language: 'ru',
      },
      { outputFile: path.join(root.dir, 'silence.wav'), pace: 'normal' },
    ),
    /тишину/u,
  );
});

test('voice-piper-длинный-текст-отказ-до-запуска', async (t) => {
  const root = installedRoot(t, 0.5);

  await assert.rejects(
    engineOf(root).synthesize(
      {
        text: 'а'.repeat(2001),
        voiceRef: 'irina',
        language: 'ru',
      },
      { outputFile: path.join(root.dir, 'long.wav'), pace: 'normal' },
    ),
    /длиннее предела/u,
  );
  await assert.rejects(
    (await import('node:fs/promises')).access(root.argvFile),
    { code: 'ENOENT' },
    'python не запускался при превышении лимита',
  );
});
