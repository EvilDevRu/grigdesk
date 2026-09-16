import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { syncTextHash } from '../../server/src/lib/showcase/scenes.ts';
import {
  publishFinalManifest,
  publishSpeechAlignment,
  readFinalManifest,
  readSpeechAlignment,
  speechAlignmentInputHash,
  SPEECH_ALIGNMENT_PRODUCER_VERSION,
} from '../../server/src/lib/showcase/syncStore.ts';
import { alignSpeechTiming } from '../../server/src/lib/showcase/voice/alignment.ts';
import {
  parseShowcaseFinalManifest,
  SHOWCASE_MANIFEST_ID_RE,
  ShowcaseManifestContractError,
} from '../../shared/showcaseTimeline.ts';

const HASH = {
  input: '1'.repeat(32),
  video: '2'.repeat(32),
  subtitles: '3'.repeat(32),
  audio: '4'.repeat(32),
  timing: '5'.repeat(32),
};

async function fixture(t) {
  const targetDir = await mkdtemp(path.join(os.tmpdir(), 'showcase-sync-store-'));

  t.after(() => rm(targetDir, { recursive: true, force: true }));

  return targetDir;
}

function manifestFixture() {
  return {
    version: 1,
    projectId: '0123456789abcdef',
    inputHash: HASH.input,
    mode: 'mixed',
    totalMs: 3_000,
    video: {
      id: 'final-0123456789ab',
      contentHash: HASH.video,
      byteSize: 12_000,
      durationMs: 3_020,
    },
    subtitles: {
      id: 'subtitles-0123456789ab',
      contentHash: HASH.subtitles,
      byteSize: 240,
    },
    scenes: [
      {
        id: 'scene-first',
        order: 1,
        caption: 'Обзор',
        startMs: 0,
        endMs: 1_800,
        durationMs: 1_800,
        planHash: '6'.repeat(32),
        mode: 'exact',
        quality: 'word-exact',
        phrases: [{
          id: 'phrase-1',
          text: 'Открываем обзор.',
          startMs: 400,
          endMs: 1_300,
        }],
        cues: [{
          cueId: 'cue-open',
          kind: 'align-start',
          actionIndex: 0,
          speechStartMs: 400,
          speechEndMs: 900,
          eventMs: 450,
          errorMs: 50,
        }],
      },
      {
        id: 'scene-second',
        order: 2,
        caption: 'Результат',
        startMs: 1_800,
        endMs: 3_000,
        durationMs: 1_200,
        planHash: '7'.repeat(32),
        mode: 'legacy',
        quality: 'phrase',
        phrases: [{
          id: 'phrase-1',
          text: 'Результат готов.',
          startMs: 2_050,
          endMs: 2_700,
        }],
        cues: [],
      },
    ],
    subtitleCues: [
      {
        index: 1,
        sceneId: 'scene-first',
        startMs: 400,
        endMs: 1_300,
        text: 'Открываем обзор.',
      },
      {
        index: 2,
        sceneId: 'scene-second',
        startMs: 2_050,
        endMs: 2_700,
        text: 'Результат готов.',
      },
    ],
  };
}

test('manifest codec принимает только согласованную измеренную шкалу', () => {
  const manifest = manifestFixture();

  assert.deepEqual(parseShowcaseFinalManifest(manifest), manifest);

  const invalid = [
    { path: ['mode'], value: 'exact' },
    { path: ['totalMs'], value: 3_100 },
    { path: ['video', 'durationMs'], value: 3_100 },
    { path: ['scenes', 1, 'startMs'], value: 1_700 },
    { path: ['scenes', 0, 'cues', 0, 'eventMs'], value: 1_900 },
    { path: ['subtitleCues', 1, 'startMs'], value: 1_000 },
  ];

  for (const edit of invalid) {
    const changed = structuredClone(manifest);
    let target = changed;

    for (const key of edit.path.slice(0, -1)) {
      target = target[key];
    }

    target[edit.path.at(-1)] = edit.value;

    assert.throws(
      () => parseShowcaseFinalManifest(changed),
      (error) => error instanceof ShowcaseManifestContractError,
      edit.path.join('.'),
    );
  }
});

test('manifest пишется атомарно под хешем байтов и проверяет владельца', async (t) => {
  const targetDir = await fixture(t);
  const manifest = manifestFixture();
  const first = await publishFinalManifest({ manifest, targetDir });
  const second = await publishFinalManifest({ manifest, targetDir });

  assert.equal(first.id, second.id, 'те же байты получают тот же content-addressed ID');
  assert.match(first.id, SHOWCASE_MANIFEST_ID_RE);
  assert.equal(first.contentHash, first.id.slice('manifest-'.length));

  const file = path.join(targetDir, `${first.id}.json`);
  const bytes = await readFile(file);
  const info = await stat(file);

  assert.equal(bytes.length, first.byteSize);
  assert.equal(info.mode & 0o077, 0);
  assert.deepEqual(await readFinalManifest({
    manifestId: first.id,
    targetDir,
    projectId: manifest.projectId,
  }), manifest);
  assert.equal(await readFinalManifest({
    manifestId: first.id,
    targetDir,
    projectId: 'fedcba9876543210',
  }), null, 'manifest другого проекта не становится своим по одному имени файла');
  assert.equal(await readFinalManifest({
    manifestId: '../project.json',
    targetDir,
  }), null);

  await writeFile(file, Buffer.concat([bytes, Buffer.from('подмена')]));

  assert.equal(await readFinalManifest({ manifestId: first.id, targetDir }), null);
});

test('alignment sidecar независимо связан с текстом, WAV и raw timing', async (t) => {
  const targetDir = await fixture(t);
  const canonicalText = 'Ещё, ещё — результат готов.';
  const textHash = syncTextHash(canonicalText);
  const alignment = alignSpeechTiming({
    canonicalText,
    durationMs: 1_500,
    timing: {
      words: [
        { text: 'еще', startMs: 100, endMs: 260 },
        { text: 'ещё', startMs: 300, endMs: 470 },
        { text: 'результат', startMs: 620, endMs: 930 },
        { text: 'готов', startMs: 960, endMs: 1_250 },
      ],
      segments: [{ text: canonicalText, startMs: 100, endMs: 1_250 }],
    },
  });
  const ref = await publishSpeechAlignment({
    alignment,
    canonicalText,
    textHash,
    audioContentHash: HASH.audio,
    speechTimingContentHash: HASH.timing,
    targetDir,
  });

  assert.ok(ref);
  assert.equal(ref.producerVersion, SPEECH_ALIGNMENT_PRODUCER_VERSION);
  assert.equal(
    ref.inputHash,
    speechAlignmentInputHash(textHash, HASH.audio, HASH.timing),
  );

  const input = {
    ref,
    canonicalText,
    textHash,
    audioContentHash: HASH.audio,
    speechTimingContentHash: HASH.timing,
    targetDir,
  };
  const document = await readSpeechAlignment(input);

  assert.equal(document.quality, 'word-exact');
  assert.equal(document.spans.length, 4);
  // Тире с измеренной тишиной — пауза синтеза внутри фразы, и она доезжает до sidecar.
  assert.deepEqual(document.safePauses, [{
    id: 'clause-2', textAt: 8, atMs: 545, quietFromMs: 470, quietToMs: 620,
  }]);

  for (const changed of [
    { ...input, textHash: '8'.repeat(32) },
    { ...input, audioContentHash: '8'.repeat(32) },
    { ...input, speechTimingContentHash: '8'.repeat(32) },
  ]) {
    assert.equal(await readSpeechAlignment(changed), null);
  }

  const file = path.join(targetDir, `${ref.id}.json`);
  const original = await readFile(file, 'utf8');

  await writeFile(file, original.replace('word-exact', 'approximate'), 'utf8');
  assert.equal(await readSpeechAlignment(input), null, 'битый sidecar не затрагивает project JSON');
});

test('alignment store не сортирует неверные диапазоны и хранит честный approximate', async (t) => {
  const targetDir = await fixture(t);
  const canonicalText = 'Раз два.';
  const textHash = syncTextHash(canonicalText);
  const common = {
    canonicalText,
    textHash,
    audioContentHash: HASH.audio,
    speechTimingContentHash: HASH.timing,
    targetDir,
  };
  const invalid = {
    canonicalText,
    durationMs: 1_000,
    quality: 'word-exact',
    spans: [
      { from: 4, to: 7, startMs: 500, endMs: 700, precision: 'word' },
      { from: 0, to: 3, startMs: 100, endMs: 300, precision: 'word' },
    ],
    phrases: [{ id: 'phrase-1', from: 0, to: 7, startMs: 100, endMs: 700 }],
    safePauses: [],
    reason: 'Неверный порядок для теста.',
  };

  assert.equal(await publishSpeechAlignment({ ...common, alignment: invalid }), null);
  assert.deepEqual(await readdir(targetDir), []);
  assert.equal(await publishSpeechAlignment({
    ...common,
    textHash: '9'.repeat(32),
    alignment: {
      canonicalText,
      durationMs: 1_000,
      quality: 'approximate',
      spans: [],
      phrases: [],
      safePauses: [],
      reason: 'Хеш не относится к строке.',
    },
  }), null);

  const approximate = {
    canonicalText,
    durationMs: 1_000,
    quality: 'approximate',
    spans: [],
    phrases: [],
    safePauses: [],
    reason: 'Текст нельзя сопоставить однозначно.',
  };
  const ref = await publishSpeechAlignment({ ...common, alignment: approximate });

  assert.ok(ref);
  assert.equal((await readSpeechAlignment({ ...common, ref })).quality, 'approximate');
});
