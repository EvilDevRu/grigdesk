// Адаптер локального голоса Piper: готовность, список и синтез.
//
// Движок подменяется исполняемым файлом с известным поведением: проверяются
// правила адаптера — как он объявляет неготовность, как зовёт движок и что
// делает с его ответом. Живой синтез проверяет последний тест, и без
// установленного окружения он честно пропускается.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { createPiperEngine } from '../../server/src/lib/showcase/voice/piper.ts';
import { voiceRuntimePaths } from '../../server/src/lib/showcase/voice/install.ts';

// Каталог голосов ищется от корня репозитория, а не от рабочего каталога: прогон
// запускает тесты из каталога пакета, и путь по cwd указывал бы мимо.
const DEFAULT_VOICE_DIR = path.join(
  fileURLToPath(new URL('../..', import.meta.url)),
  'server',
  '.state',
  'showcase-voice',
);

const DIRECTION = {
  tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
};

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-piper-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Подменённый python: отвечает на проверку модуля и на вызов синтеза. Аргументы
 * записываются в файл — так видно, ЧЕМ адаптер зовёт движок, а не только что
 * вызов состоялся.
 */
async function fakePython(root, { facts = '{"durationMs": 1500, "sampleRate": 22050, "channels": 1, "peak": 0.4}', hasModule = true } = {}) {
  const file = path.join(root, 'python');
  const calls = path.join(root, 'calls.txt');

  await writeFile(
    file,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [[ "$1" == '-c' ]]; then
  ${hasModule ? 'exit 0' : 'echo "ModuleNotFoundError" >&2; exit 1'}
fi
out=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '--out' ]]; then out=$2; fi
  shift
done
cat > /dev/null
printf 'речь' > "$out"
echo '${facts}'
`,
    'utf8',
  );
  await chmod(file, 0o755);

  return { python: file, calls };
}

async function installVoice(voicesDir, id = 'irina') {
  const dir = path.join(voicesDir, id);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'voice.onnx'), 'модель', 'utf8');
  await writeFile(path.join(dir, 'voice.onnx.json'), '{}', 'utf8');
  await writeFile(
    path.join(dir, 'voice.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Ирина',
      language: 'ru',
      timbre: 'женский',
      model: 'voice.onnx',
      config: 'voice.onnx.json',
      sampleRate: 22_050,
    }),
    'utf8',
  );
}

test('без установки движок объявляет себя неготовым и называет действие', async (t) => {
  const root = await workspace(t);
  const engine = createPiperEngine({ python: '', voicesDir: path.join(root, 'voices') });
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.install, /кнопк/i, 'человеку названо, что именно делать');
  assert.deepEqual(await engine.voices(), []);
});

test('движок есть, а голоса нет — это отдельная причина', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root);
  const engine = createPiperEngine({ python, voicesDir: path.join(root, 'voices') });
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.reason, /ни один голос не скачан/);
});

test('окружение без модуля синтеза названо своей причиной', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root, { hasModule: false });
  const voicesDir = path.join(root, 'voices');

  await installVoice(voicesDir);

  const engine = createPiperEngine({ python, voicesDir });
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.reason, /модул/);
});

test('синтез зовёт движок выбранным голосом и берёт факты из его ответа', async (t) => {
  const root = await workspace(t);
  const { python, calls } = await fakePython(root);
  const voicesDir = path.join(root, 'voices');

  await installVoice(voicesDir);

  const engine = createPiperEngine({ python, voicesDir });
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'ready');

  const candidate = await engine.synthesize(
    {
      canonicalText: 'Открываем раздел.',
      direction: { ...DIRECTION, pace: 'slow' },
      voiceRef: 'irina',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.equal(candidate.format, 'wav');
  assert.equal(candidate.sampleRate, 22_050, 'частота берётся из ответа движка, а не из манифеста');
  await access(candidate.temporaryFile);

  const argv = await readFile(calls, 'utf8');

  assert.match(argv, /--model .*irina\/voice\.onnx/, 'модель выбранного голоса');
  assert.match(argv, /--length-scale 1\.15/, 'медленный темп переведён в единицы движка');
});

test('тишина вместо речи — отказ, а не готовый звук', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root, {
    facts: '{"durationMs": 1500, "sampleRate": 22050, "channels": 1, "peak": 0.0}',
  });
  const voicesDir = path.join(root, 'voices');

  await installVoice(voicesDir);

  const engine = createPiperEngine({ python, voicesDir });

  await assert.rejects(
    () => engine.synthesize(
      {
        canonicalText: 'Открываем раздел.', direction: DIRECTION, voiceRef: 'irina', language: 'ru',
      },
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_failed' && /тишин/.test(error.message),
  );
});

test('установленный движок произносит фразу по-настоящему', async (t) => {
  const voiceDir = process.env.COCKPIT_SHOWCASE_VOICE_DIR || DEFAULT_VOICE_DIR;
  const runtime = voiceRuntimePaths(voiceDir);
  const engine = createPiperEngine(runtime);
  const doctor = await engine.doctor();

  if (doctor.status !== 'ready') {
    t.skip(`локальный голос не установлен: ${doctor.reason}`);

    return;
  }

  const root = await workspace(t);
  const voices = await engine.voices();
  const candidate = await engine.synthesize(
    {
      canonicalText: 'Проверка голоса: раздел собирает ролик из трёх сцен.',
      direction: DIRECTION,
      voiceRef: voices[0].id,
      language: 'ru',
    },
    { outputDir: root, deadlineMs: 120_000, signal: undefined },
  );
  const produced = await readFile(candidate.temporaryFile);

  assert.ok(produced.byteLength > 20_000, 'настоящая речь весит больше пустышки');
  assert.equal(produced.subarray(0, 4).toString('latin1'), 'RIFF');
});
