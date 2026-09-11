// Адаптер локального голоса Silero: готовность, дикторы и синтез.
//
// Движок подменяется исполняемым файлом с известным поведением: проверяются
// правила адаптера — как он объявляет неготовность, как зовёт движок и что
// делает с его ответом. Одна модель несёт несколько дикторов, и именно они, а не
// файл, должны быть голосами в списке.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSileroEngine, readInstalledSileroModels } from '../../server/src/lib/showcase/voice/silero.ts';
import { SILERO_VOICES } from '../../server/src/lib/showcase/voice/sileroCatalog.ts';

const DIRECTION = {
  tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
};

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-silero-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Подменённый python: отвечает на проверку модуля и на вызов синтеза. Аргументы
 * записываются в файл — так видно, ЧЕМ адаптер зовёт движок.
 */
async function fakePython(root, {
  facts = '{"durationMs": 2100, "sampleRate": 48000, "channels": 1, "peak": 0.5}',
  hasModule = true,
} = {}) {
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
printf 'RIFF' > "$out"
echo '${facts}'
`,
    'utf8',
  );
  await chmod(file, 0o755);

  return { python: file, calls };
}

async function installModel(modelsDir, overrides = {}) {
  const pack = { ...SILERO_VOICES[0], ...overrides };
  const modelDir = path.join(modelsDir, pack.id);

  await mkdir(modelDir, { recursive: true });
  await writeFile(path.join(modelDir, pack.fileName), 'модель', 'utf8');
  await writeFile(path.join(modelDir, 'voice.json'), JSON.stringify({
    schemaVersion: 1,
    id: pack.id,
    name: pack.name,
    language: 'ru',
    file: pack.fileName,
    sampleRate: pack.sampleRate,
    speakers: pack.speakers,
  }), 'utf8');
}

test('каталог Silero закрепляет адрес, размер, сумму и дикторов', () => {
  const pack = SILERO_VOICES[0];

  assert.equal(pack.engineId, 'silero');
  assert.match(pack.url, /^https:\/\/models\.silero\.ai\//);
  assert.match(pack.fileSha256, /^[0-9a-f]{64}$/);
  assert.ok(pack.fileBytes > 10_000_000);
  assert.ok(pack.speakers.length >= 5, 'модель несёт несколько дикторов');
  assert.ok(pack.speakers.every((speaker) => speaker.name && speaker.timbre));
});

test('без установки движок объявляет себя неготовым и называет действие', async () => {
  const engine = createSileroEngine({ python: '', modelsDir: '/nowhere' });
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.install, /кнопкой/);
  assert.deepEqual(await engine.voices(), []);
});

test('окружение без torch названо своей причиной', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root, { hasModule: false });
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  const doctor = await createSileroEngine({ python, modelsDir }).doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.reason, /torch/);
});

test('голосами становятся дикторы установленной модели', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root);
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  const models = await readInstalledSileroModels(modelsDir);

  assert.equal(models.length, 1);

  const voices = await createSileroEngine({ python, modelsDir }).voices();

  assert.deepEqual(
    voices.map((voice) => voice.id),
    SILERO_VOICES[0].speakers.map((speaker) => speaker.id),
  );
  assert.ok(voices.every((voice) => voice.available));
  assert.match(voices[0].name, /женский|мужской/, 'тембр назван рядом с именем');
});

test('синтез зовёт движок выбранным диктором и переводит темп', async (t) => {
  const root = await workspace(t);
  const { python, calls } = await fakePython(root);
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  const engine = createSileroEngine({ python, modelsDir });
  const candidate = await engine.synthesize(
    {
      canonicalText: 'Фильтр сбрасывается одним нажатием.',
      direction: { ...DIRECTION, pace: 'fast' },
      voiceRef: 'aidar',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.equal(candidate.format, 'wav');
  assert.equal(candidate.sampleRate, 48_000);
  await access(candidate.temporaryFile);

  const argv = await readFile(calls, 'utf8');

  assert.match(argv, /--model .*v5_5_ru\/v5_5_ru\.pt/);
  assert.match(argv, /--speaker aidar/);
  assert.match(argv, /--rate fast/);
});

test('тишина вместо речи — отказ, а не готовый звук', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root, {
    facts: '{"durationMs": 2100, "sampleRate": 48000, "channels": 1, "peak": 0.0}',
  });
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  await assert.rejects(
    () => createSileroEngine({ python, modelsDir }).synthesize(
      {
        canonicalText: 'Тихая фраза.',
        direction: DIRECTION,
        voiceRef: 'xenia',
        language: 'ru',
      },
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_failed' && /тишин/.test(error.message),
  );
});

test('две версии модели с теми же дикторами дают один список, а говорит новая', async (t) => {
  const root = await workspace(t);
  const { python, calls } = await fakePython(root);
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);
  await installModel(modelsDir, { id: 'v4_ru', name: 'Silero v4', fileName: 'v4_ru.pt' });

  const engine = createSileroEngine({ python, modelsDir });
  const voices = await engine.voices();

  assert.equal(voices.length, SILERO_VOICES[0].speakers.length, 'дикторы не удваиваются');
  assert.equal(engine.capabilities(null).engineVersion, 'silero-v5_5_ru');

  await engine.synthesize(
    {
      canonicalText: 'Говорит новая версия.',
      direction: DIRECTION,
      voiceRef: 'xenia',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.match(await readFile(calls, 'utf8'), /--model .*v5_5_ru\/v5_5_ru\.pt/);
});
