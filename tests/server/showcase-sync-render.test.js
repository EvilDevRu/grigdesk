// Точный монтаж смысловых привязок на настоящем MP4.
//
// Одного JSON-плана для этой проверки недостаточно: ffmpeg может принять граф,
// округлить PTS или обрезать AAC так, что числа плана останутся правильными, а
// экран и звуковая метка разойдутся. Поэтому тест декодирует готовые дорожки и
// измеряет их независимо.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildSyncedSceneClip } from '../../server/src/lib/showcase/render/assembler.ts';
import { planShowcaseSync } from '../../server/src/lib/showcase/render/syncPlan.ts';
import { wavOfPcm } from '../../server/src/lib/showcase/voice/pcm.ts';

const run = promisify(execFile);

const SAMPLE_RATE = 48_000;
const FRAME_RATE = 30;
const FRAME_MS = 1000 / FRAME_RATE;
const STYLE = {
  width: 320,
  height: 180,
  fps: FRAME_RATE,
  theme: 'dark',
  locale: 'ru-RU',
  burnSubtitles: false,
};

const CANONICAL_TEXT = 'Открываем диалог. Здесь готов результат.';
const ACTIONS = [
  { kind: 'click' },
  { kind: 'waitVisible' },
  { kind: 'highlight' },
];
const BINDINGS = {
  version: 1,
  textHash: 'text-fixture',
  actionsHash: 'actions-fixture',
  cues: [
    {
      id: 'cue-click',
      actionIndex: 0,
      from: 0,
      to: 16,
      kind: 'align-start',
      origin: 'manual',
    },
    {
      id: 'cue-ready',
      actionIndex: 1,
      from: 18,
      to: 39,
      kind: 'ready-before',
      origin: 'manual',
    },
    {
      id: 'cue-highlight',
      actionIndex: 2,
      from: 18,
      to: 39,
      kind: 'hold-through',
      origin: 'manual',
    },
  ],
};

const VIDEO_PALETTE = {
  selection: [41, 240, 110],
  click: [106, 202, 222],
  loading: [210, 16, 146],
  result: [144, 54, 34],
};

/** Создаёт ровно 120 кадров VP8: выбор → клик → загрузка → результат. */
async function makeRawVideo(file) {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180:r=30:d=0.9',
    '-f', 'lavfi', '-i', 'color=c=0xff00ff:s=320x180:r=30:d=0.2',
    '-f', 'lavfi', '-i', 'color=c=0xffff00:s=320x180:r=30:d=2.1',
    '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:r=30:d=0.8',
    '-filter_complex',
    '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-an',
    '-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '4',
    '-b:v', '200k', '-pix_fmt', 'yuv420p',
    file,
  ]);

  return file;
}

/** WAV с короткими тонами на известных отсчётах и нулевой тишиной между ними. */
async function makeMarkerWave(file, durationMs, markers) {
  const sampleCount = Math.round(durationMs * SAMPLE_RATE / 1000);
  const pcm = Buffer.alloc(sampleCount * 2);

  for (const marker of markers) {
    const from = Math.round(marker.startMs * SAMPLE_RATE / 1000);
    const to = Math.round(marker.endMs * SAMPLE_RATE / 1000);

    for (let sample = from; sample < to; sample += 1) {
      const phaseSample = sample - from;
      const value = Math.round(
        12_000 * Math.sin(2 * Math.PI * marker.frequency * phaseSample / SAMPLE_RATE),
      );

      pcm.writeInt16LE(value, sample * 2);
    }
  }

  await writeFile(file, wavOfPcm(pcm, SAMPLE_RATE));

  return { file, sampleCount };
}

function nearestState(y, u, v) {
  return Object.entries(VIDEO_PALETTE).reduce((best, [state, center]) => {
    const distance = (y - center[0]) ** 2
      + (u - center[1]) ** 2
      + (v - center[2]) ** 2;

    return distance < best.distance ? { state, distance } : best;
  }, { state: null, distance: Number.POSITIVE_INFINITY }).state;
}

/** Читает начало каждого различимого состояния именно из PTS готового MP4. */
async function readVideoStates(file) {
  const escaped = file.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-f', 'lavfi', '-i', `movie=${escaped},signalstats`,
    '-show_frames',
    '-show_entries', [
      'frame=best_effort_timestamp_time',
      [
        'lavfi.signalstats.YAVG',
        'lavfi.signalstats.UAVG',
        'lavfi.signalstats.VAVG',
      ].join(','),
    ].join(':frame_tags='),
    '-of', 'json',
  ], { maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const states = [];

  for (const frame of parsed.frames ?? []) {
    const atMs = Number(frame.best_effort_timestamp_time) * 1000;
    const y = Number(frame.tags?.['lavfi.signalstats.YAVG']);
    const u = Number(frame.tags?.['lavfi.signalstats.UAVG']);
    const v = Number(frame.tags?.['lavfi.signalstats.VAVG']);

    if (![atMs, y, u, v].every(Number.isFinite)) {
      continue;
    }

    const state = nearestState(y, u, v);
    const previous = states.at(-1);

    if (previous?.state !== state) {
      states.push({ state, startMs: atMs, endMs: atMs + FRAME_MS });
    } else {
      previous.endMs = atMs + FRAME_MS;
    }
  }

  return states;
}

async function readFrameLumas(file) {
  const escaped = file.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-f', 'lavfi', '-i', `movie=${escaped},signalstats`,
    '-show_frames',
    '-show_entries', 'frame_tags=lavfi.signalstats.YAVG',
    '-of', 'json',
  ], { maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);

  return (parsed.frames ?? []).map((frame) => Number(
    frame.tags?.['lavfi.signalstats.YAVG'],
  ));
}

async function readHighlightRoi(file) {
  const escaped = file.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-f', 'lavfi', '-i', `movie=${escaped},crop=4:48:40:44,signalstats`,
    '-show_frames',
    '-show_entries', [
      'frame=best_effort_timestamp_time',
      'frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.VAVG',
    ].join(':'),
    '-of', 'json',
  ], { maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);

  return (parsed.frames ?? []).map((frame) => ({
    atMs: Number(frame.best_effort_timestamp_time) * 1000,
    y: Number(frame.tags?.['lavfi.signalstats.YAVG']),
    v: Number(frame.tags?.['lavfi.signalstats.VAVG']),
  })).filter((frame) => [frame.atMs, frame.y, frame.v].every(Number.isFinite));
}

/** Декодирует AAC обратно в PCM: метки ищутся по энергии, без доверия плану. */
async function readAudioMarkers(file, pcmFile) {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-map', '0:a:0', '-vn',
    '-c:a', 'pcm_s16le',
    '-ar', String(SAMPLE_RATE), '-ac', '1',
    '-f', 's16le',
    pcmFile,
  ]);
  const pcm = await readFile(pcmFile);
  const windowSamples = SAMPLE_RATE / 200;
  const active = [];

  for (let from = 0; from < pcm.length / 2; from += windowSamples) {
    const to = Math.min(pcm.length / 2, from + windowSamples);
    let squareSum = 0;

    for (let sample = from; sample < to; sample += 1) {
      const value = pcm.readInt16LE(sample * 2);

      squareSum += value * value;
    }

    if (Math.sqrt(squareSum / (to - from)) >= 1000) {
      active.push({ from, to });
    }
  }

  const merged = [];

  for (const interval of active) {
    const previous = merged.at(-1);

    if (previous && interval.from - previous.to <= SAMPLE_RATE * 0.03) {
      previous.to = interval.to;
    } else {
      merged.push({ ...interval });
    }
  }

  return {
    durationMs: pcm.length / 2 * 1000 / SAMPLE_RATE,
    intervals: merged.map((interval) => ({
      startMs: interval.from * 1000 / SAMPLE_RATE,
      endMs: interval.to * 1000 / SAMPLE_RATE,
    })).filter((interval) => interval.endMs - interval.startMs >= 50),
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-sync-render-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return {
    root,
    rawVideo: await makeRawVideo(path.join(root, 'states.webm')),
  };
}

function bindingInput(bindings = BINDINGS) {
  return {
    bindings,
    canonicalText: CANONICAL_TEXT,
    actions: ACTIONS,
    expectedTextHash: 'text-fixture',
    expectedActionsHash: 'actions-fixture',
  };
}

const PACES = {
  normal: {
    durationMs: 4800,
    clickMs: 3000,
    readyPhraseMs: 4000,
    pause: {
      id: 'between-phrases',
      textAt: 18,
      atMs: 3500,
      quietFromMs: 3300,
      quietToMs: 3900,
    },
    expectedClickMs: 3400,
    expectedResultMs: 5600,
    expectedTotalMs: 7000,
  },
  fast: {
    durationMs: 2800,
    clickMs: 1500,
    readyPhraseMs: 2200,
    pause: {
      id: 'between-phrases',
      textAt: 18,
      atMs: 1850,
      quietFromMs: 1800,
      quietToMs: 2100,
    },
    expectedClickMs: 1900,
    expectedResultMs: 4100,
    expectedTotalMs: 5500,
  },
};

function speechFixture(paceName, safePauses) {
  const pace = PACES[paceName];

  return {
    canonicalText: CANONICAL_TEXT,
    durationMs: pace.durationMs,
    sampleRate: SAMPLE_RATE,
    sampleCount: pace.durationMs * SAMPLE_RATE / 1000,
    quality: 'word-exact',
    spans: [
      {
        from: 0,
        to: 16,
        startMs: pace.clickMs,
        endMs: pace.clickMs + 200,
        precision: 'word',
      },
      {
        from: 18,
        to: 39,
        startMs: pace.readyPhraseMs,
        endMs: pace.readyPhraseMs + 600,
        precision: 'word',
      },
    ],
    phrases: [
      {
        id: 'phrase-click',
        from: 0,
        to: 16,
        startMs: pace.clickMs,
        endMs: pace.clickMs + 200,
      },
      {
        id: 'phrase-result',
        from: 18,
        to: 39,
        startMs: pace.readyPhraseMs,
        endMs: pace.readyPhraseMs + 600,
      },
    ],
    safePauses: safePauses ?? [pace.pause],
  };
}

function recordingFixture() {
  return {
    durationMs: 4000,
    calibration: 'fixture-exact',
    calibrationErrorMs: 0,
    actions: [
      {
        actionIndex: 0,
        kind: 'click',
        startMs: 900,
        anchorMs: 1000,
        endMs: 1100,
        readyMs: null,
      },
      {
        actionIndex: 1,
        kind: 'waitVisible',
        startMs: 1100,
        anchorMs: 1100,
        endMs: 3200,
        readyMs: 3200,
      },
      {
        actionIndex: 2,
        kind: 'highlight',
        startMs: 3200,
        anchorMs: 3200,
        endMs: 3200,
        readyMs: null,
      },
    ],
    stableIntervals: [
      {
        id: 'selection-stable',
        fromMs: 0,
        toMs: 900,
        frameMs: 800,
        afterActionIndex: null,
        beforeActionIndex: 0,
      },
      {
        id: 'result-stable',
        fromMs: 3200,
        toMs: 3900,
        frameMs: 3233 + 1 / 3,
        afterActionIndex: 2,
        beforeActionIndex: null,
      },
      {
        id: 'terminal-stable',
        fromMs: 3900,
        toMs: 4000,
        frameMs: 3900,
        afterActionIndex: 2,
        beforeActionIndex: null,
      },
    ],
    removableWaits: [],
    highlights: [
      {
        actionIndex: 2,
        x: 40,
        y: 40,
        width: 100,
        height: 60,
        validFromMs: 3200,
        validToMs: 3900,
        stableIntervalId: 'result-stable',
      },
    ],
  };
}

function syncInput({
  paceName = 'normal',
  bindings = BINDINGS,
  safePauses,
  recording = recordingFixture(),
  limits = { maxSceneMs: 10_000, remainingFilmMs: 10_000 },
} = {}) {
  const speech = speechFixture(paceName, safePauses);

  return {
    bindingInput: bindingInput(bindings),
    speech,
    recording,
    legacy: {
      audioMs: speech.durationMs,
      clipMs: recording.durationMs,
    },
    style: {
      width: STYLE.width,
      height: STYLE.height,
      fps: STYLE.fps,
    },
    limits,
  };
}

function exactPlan(input) {
  const result = planShowcaseSync(input);

  assert.equal(
    result.status,
    'exact',
    `ожидался точный план: ${JSON.stringify(result.diagnostics)}`,
  );

  return result;
}

function diagnosticCodes(result) {
  return result.diagnostics.map((item) => item.code);
}

function assertNear(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual.toFixed(1)} мс вместо ${expected.toFixed(1)}±${tolerance} мс`,
  );
}

test('planner детерминированно совмещает normal и fast без ускорения дорожек', () => {
  for (const paceName of ['normal', 'fast']) {
    const input = syncInput({ paceName });
    const snapshot = structuredClone(input);
    const first = exactPlan(input);
    const repeated = exactPlan(structuredClone(input));

    assert.deepEqual(input, snapshot, `${paceName}: planner не меняет входные измерения`);
    assert.deepEqual(repeated, first, `${paceName}: одинаковый вход даёт одинаковый план`);
    assert.equal(first.plan.timing.totalMs, PACES[paceName].expectedTotalMs);
    assert.deepEqual(first.plan.cues.map((cue) => cue.actionIndex), [0, 1, 2]);
    assert.ok(first.plan.cues.every((cue) => cue.errorMs <= 250));
    assert.equal(first.plan.cues[0].eventMs, PACES[paceName].expectedClickMs);
    assert.equal(first.plan.cues[1].eventMs, PACES[paceName].expectedResultMs);
    assert.ok(first.plan.cues[1].eventMs <= first.plan.cues[1].speechStartMs);
    assert.deepEqual(diagnosticCodes(first), ['video_hold_added', 'silence_inserted']);
    assert.equal(first.plan.highlights[0].startMs, first.plan.cues[2].speechStartMs);
    assert.equal(first.plan.highlights[0].endMs, first.plan.cues[2].speechEndMs);
    assert.equal(first.plan.videoParts.at(-1).outputToMs, first.plan.timing.totalMs);
    assert.equal(first.plan.audioParts.at(-1).outputToMs, first.plan.timing.totalMs);
    assert.ok(first.plan.audioParts.some((part) => (
      part.kind === 'silence' && part.reason === 'tail'
    )));
    assert.ok(first.plan.audioParts.every((part) => (
      part.kind === 'source' || Number.isSafeInteger(part.sampleCount)
    )), `${paceName}: тишина задана целыми PCM-отсчётами`);
  }
});

test('границы кадров, калибровка и повторная пауза не ломают точный план', () => {
  const reusedRecording = recordingFixture();

  reusedRecording.actions[1] = {
    ...reusedRecording.actions[1],
    endMs: 2800,
    readyMs: 2800,
  };

  const reused = exactPlan(syncInput({ recording: reusedRecording }));
  const cueSilences = reused.plan.audioParts.filter((part) => (
    part.kind === 'silence' && part.reason === 'cue-delay'
  ));

  assert.deepEqual(diagnosticCodes(reused), [
    'video_hold_added',
    'silence_inserted',
    'silence_inserted',
  ]);
  assert.equal(cueSilences.length, 1, 'одна граница паузы не создаёт два пересекающихся разреза');
  assert.equal(cueSilences[0].sampleCount, 57_600);
  assert.equal(cueSilences[0].outputToMs - cueSilences[0].outputFromMs, 1200);
  assert.equal(reused.plan.cues[1].speechStartMs, 5600);
  assert.equal(reused.plan.cues[1].eventMs, 5200);
  assert.equal(reused.plan.cues[2].speechStartMs, 5600);
  assert.equal(reused.plan.cues[2].eventMs, 5600);

  const calibratedRecording = recordingFixture();

  calibratedRecording.calibration = 'calibrated';
  calibratedRecording.calibrationErrorMs = 100;

  const calibrated = exactPlan(syncInput({ recording: calibratedRecording }));

  assert.equal(calibrated.plan.cues[0].errorMs, 100);
  assert.ok(
    calibrated.plan.cues[1].eventMs + 100 <= calibrated.plan.cues[1].speechStartMs,
    'ready-before учитывает худшую границу погрешности',
  );
  assert.equal(calibrated.plan.cues[2].errorMs, 0);

  for (const part of calibrated.plan.videoParts) {
    const frames = (part.outputToMs - part.outputFromMs) / FRAME_MS;

    assertNear(frames, Math.round(frames), 1e-6, 'видеочасть лежит на CFR-сетке');
  }

  const terminalRecording = recordingFixture();
  const terminalBaseline = exactPlan(syncInput({ recording: recordingFixture() }));

  terminalRecording.stableIntervals = terminalRecording.stableIntervals
    .filter((interval) => interval.id !== 'terminal-stable');
  terminalRecording.stableIntervals.push({
    id: 'terminal-at-action-end',
    fromMs: 3200,
    toMs: 4000,
    frameMs: 3200,
    afterActionIndex: 2,
    beforeActionIndex: null,
  });

  const terminal = exactPlan(syncInput({ recording: terminalRecording }));
  const terminalHold = terminal.plan.videoParts.find((part) => (
    part.kind === 'hold' && part.cueId === null && part.sourceAtMs === 3200
  ));

  assert.ok(terminalHold, 'кадр ровно на конце действия годится для хвоста');
  assert.deepEqual(
    terminal.plan.cues.map((cue) => [cue.cueId, cue.eventMs, cue.speechStartMs]),
    terminalBaseline.plan.cues.map((cue) => [cue.cueId, cue.eventMs, cue.speechStartMs]),
    'финальный hold не сдвигает предыдущие cue',
  );

  assert.deepEqual(terminal.plan.sourceAudio, {
    sampleRate: SAMPLE_RATE,
    sampleCount: PACES.normal.durationMs * SAMPLE_RATE / 1000,
    durationMs: PACES.normal.durationMs,
  });
  assert.deepEqual(terminal.plan.sourceVideo, {
    durationMs: terminalRecording.durationMs,
    fps: FRAME_RATE,
  });

  for (const corruptPause of [
    { ...PACES.normal.pause, textAt: 0 },
    { ...PACES.normal.pause, quietFromMs: 3100 },
  ]) {
    const invalid = planShowcaseSync(syncInput({ safePauses: [corruptPause] }));

    assert.equal(invalid.status, 'conflict');
    assert.deepEqual(diagnosticCodes(invalid), ['invalid_speech_timing']);
  }
});

test('ранний stable frame подсветки не сдвигает защищённые cue', () => {
  const recording = recordingFixture();

  recording.stableIntervals = recording.stableIntervals.map((interval) => (
    interval.id === 'result-stable'
      ? {
        id: 'early-highlight',
        fromMs: 1100,
        toMs: 3500,
        frameMs: 1100,
        afterActionIndex: null,
        beforeActionIndex: null,
      }
      : interval
  ));
  recording.highlights[0] = {
    ...recording.highlights[0],
    validFromMs: 1100,
    validToMs: 3500,
    stableIntervalId: 'early-highlight',
  };

  const result = planShowcaseSync(syncInput({ recording }));

  assert.equal(result.status, 'conflict');
  assert.equal(result.diagnostics.at(-1).code, 'no_stable_frame');
  assert.equal(result.diagnostics.at(-1).cueId, 'cue-highlight');
});

test('legacy и stale остаются различимыми, а невозможная вставка даёт conflict', () => {
  const legacyInput = syncInput();

  legacyInput.bindingInput = null;
  legacyInput.speech = null;
  legacyInput.recording = null;

  const legacy = planShowcaseSync(legacyInput);

  assert.equal(legacy.status, 'legacy');
  assert.deepEqual(diagnosticCodes(legacy), ['missing_bindings']);
  assert.deepEqual(legacy.timing, {
    preRollMs: 400,
    narrationStartMs: 400,
    speechEndMs: 5200,
    actionsEndMs: 4000,
    postRollMs: 600,
    totalMs: 5800,
  });

  const noSpeech = syncInput();

  noSpeech.speech = null;
  assert.deepEqual(diagnosticCodes(planShowcaseSync(noSpeech)), ['missing_speech_timing']);

  const noRecording = syncInput();

  noRecording.recording = null;
  assert.deepEqual(diagnosticCodes(planShowcaseSync(noRecording)), ['missing_recording_timing']);

  const approximate = syncInput();

  approximate.speech.quality = 'phrase';
  assert.deepEqual(diagnosticCodes(planShowcaseSync(approximate)), ['approximate_speech_timing']);

  const uncalibrated = syncInput();

  uncalibrated.recording.calibration = 'unavailable';
  assert.deepEqual(diagnosticCodes(planShowcaseSync(uncalibrated)), ['uncalibrated_recording']);

  const stale = planShowcaseSync(syncInput({
    bindings: { ...BINDINGS, textHash: 'previous-text' },
  }));

  assert.equal(stale.status, 'conflict');
  assert.deepEqual(diagnosticCodes(stale), ['stale_bindings']);

  const noPause = planShowcaseSync(syncInput({ safePauses: [] }));

  assert.equal(noPause.status, 'conflict');
  assert.equal(noPause.diagnostics.at(-1).code, 'no_safe_pause');
  assert.equal(noPause.diagnostics.at(-1).cueId, 'cue-ready');

  const noInitialStable = recordingFixture();

  noInitialStable.stableIntervals = noInitialStable.stableIntervals.filter(
    (interval) => interval.id !== 'selection-stable',
  );

  const noStable = planShowcaseSync(syncInput({ recording: noInitialStable }));

  assert.equal(noStable.status, 'conflict');
  assert.deepEqual(diagnosticCodes(noStable), ['no_stable_frame']);

  const stringWaitIndex = recordingFixture();

  stringWaitIndex.removableWaits = [{
    id: 'bad-index',
    fromMs: 2200,
    toMs: 3000,
    beforeActionIndex: '1',
  }];

  const invalidWait = planShowcaseSync(syncInput({ recording: stringWaitIndex }));

  assert.equal(invalidWait.status, 'conflict');
  assert.deepEqual(diagnosticCodes(invalidWait), ['invalid_recording_timing']);
});

test('лимиты сцены и фильма проверяются до выдачи точного плана', () => {
  const sceneLimited = planShowcaseSync(syncInput({
    limits: { maxSceneMs: 6999, remainingFilmMs: 10_000 },
  }));
  const filmLimited = planShowcaseSync(syncInput({
    limits: { maxSceneMs: 10_000, remainingFilmMs: 6999 },
  }));

  assert.equal(sceneLimited.status, 'conflict');
  assert.equal(sceneLimited.diagnostics.at(-1).code, 'scene_limit_exceeded');
  assert.equal(sceneLimited.diagnostics.at(-1).requiredMs, 7000);
  assert.equal(sceneLimited.diagnostics.at(-1).availableMs, 6999);
  assert.equal(filmLimited.status, 'conflict');
  assert.equal(filmLimited.diagnostics.at(-1).code, 'film_limit_exceeded');
  assert.equal(filmLimited.diagnostics.at(-1).requiredMs, 7000);
  assert.equal(filmLimited.diagnostics.at(-1).availableMs, 6999);
});

test('явное пустое ожидание удаляется до вставки тишины без перестановки состояний', () => {
  const recording = recordingFixture();

  recording.actions[1] = {
    ...recording.actions[1],
    startMs: 3000,
    anchorMs: 3000,
  };
  recording.removableWaits = [{
    id: 'wait-before-result',
    fromMs: 2200,
    toMs: 3000,
    beforeActionIndex: 1,
  }];

  const result = exactPlan(syncInput({ recording }));
  const cueSilence = result.plan.audioParts.find((part) => (
    part.kind === 'silence' && part.reason === 'cue-delay'
  ));
  const sourceParts = result.plan.videoParts.filter((part) => part.kind === 'source');

  assert.deepEqual(result.plan.removedWaits, [{
    id: 'wait-before-result',
    sourceFromMs: 2200,
    sourceToMs: 3000,
    removedMs: 800,
    cueId: 'cue-ready',
  }]);
  assert.equal(cueSilence.outputToMs - cueSilence.outputFromMs, 400);
  assert.deepEqual(diagnosticCodes(result), [
    'video_hold_added',
    'empty_wait_removed',
    'silence_inserted',
  ]);

  for (let index = 1; index < sourceParts.length; index += 1) {
    assert.ok(
      sourceParts[index].sourceFromMs >= sourceParts[index - 1].sourceToMs,
      'исходные участки видео сохраняют порядок записи',
    );
  }

  const partialInput = syncInput({ recording: structuredClone(recording) });

  partialInput.speech.spans[1].startMs = 4507;
  partialInput.speech.phrases[1].startMs = 4507;

  const partial = exactPlan(partialInput);
  const partialSilence = partial.plan.audioParts.find((part) => (
    part.kind === 'silence' && part.reason === 'cue-delay'
  ));

  assertNear(partial.plan.removedWaits[0].removedMs, 20 * FRAME_MS, 0.01, 'частичный cut');
  assert.equal(partialSilence.sampleCount, 1264, 'дробный остаток компенсируется PCM-тишиной');
  assert.equal(partial.plan.cues[1].errorMs, 0);
});

test('measured explicit wait можно вырезать внутри самого wait action', () => {
  const recording = recordingFixture();
  const actions = [
    ACTIONS[0],
    { kind: 'wait' },
    ACTIONS[1],
    ACTIONS[2],
  ];

  recording.actions = [
    recording.actions[0],
    {
      actionIndex: 1,
      kind: 'wait',
      startMs: 1100,
      anchorMs: 1100,
      endMs: 1900,
      readyMs: null,
    },
    {
      ...recording.actions[1],
      actionIndex: 2,
      startMs: 1900,
      anchorMs: 1900,
    },
    { ...recording.actions[2], actionIndex: 3 },
  ];
  recording.stableIntervals = recording.stableIntervals.map((interval) => ({
    ...interval,
    afterActionIndex: interval.afterActionIndex === 2 ? 3 : interval.afterActionIndex,
  }));
  recording.highlights = recording.highlights.map((highlight) => ({
    ...highlight,
    actionIndex: 3,
  }));
  recording.removableWaits = [{
    id: 'explicit-wait-1',
    fromMs: 1100,
    toMs: 1900,
    actionIndex: 1,
    beforeActionIndex: 2,
  }];

  const bindings = {
    ...BINDINGS,
    cues: BINDINGS.cues.map((cue) => ({
      ...cue,
      actionIndex: cue.actionIndex === 0 ? 0 : cue.actionIndex + 1,
    })),
  };
  const input = syncInput({ recording, bindings });

  input.bindingInput = {
    ...input.bindingInput,
    actions,
  };

  const result = exactPlan(input);

  assert.equal(result.plan.removedWaits[0]?.id, 'explicit-wait-1');
  assert.equal(result.plan.removedWaits[0]?.removedMs, 800);
});

test('direct assembler сохраняет PTS событий и AAC-маркеры в normal и fast', async (t) => {
  const media = await fixture(t);

  for (const paceName of ['normal', 'fast']) {
    const pace = PACES[paceName];
    const audio = path.join(media.root, `${paceName}.wav`);
    const output = path.join(media.root, `${paceName}.mp4`);
    const pcm = path.join(media.root, `${paceName}.pcm`);

    await makeMarkerWave(audio, pace.durationMs, [
      { startMs: pace.clickMs, endMs: pace.clickMs + 200, frequency: 880 },
      {
        startMs: pace.readyPhraseMs,
        endMs: pace.readyPhraseMs + 600,
        frequency: 1320,
      },
    ]);

    const { plan } = exactPlan(syncInput({ paceName }));

    await buildSyncedSceneClip({
      rawVideo: media.rawVideo,
      audio,
      plan,
      outFile: output,
      style: STYLE,
    });

    const states = await readVideoStates(output);
    const decoded = await readAudioMarkers(output, pcm);
    const highlightRoi = await readHighlightRoi(output);
    const click = states.find((state) => state.state === 'click');
    const result = states.find((state) => state.state === 'result');

    assert.deepEqual(
      states.map((state) => state.state),
      ['selection', 'click', 'loading', 'result'],
      `${paceName}: состояния не переставлены и не повторены`,
    );
    assert.equal(decoded.intervals.length, 2, `${paceName}: обе звуковые метки сохранены`);
    assert.ok(click && result);

    const clickPtsMs = (click.startMs + click.endMs) / 2;
    const [clickTone, resultTone] = decoded.intervals;

    assertNear(clickTone.startMs, plan.cues[0].speechStartMs, 40, `${paceName}: первый PCM`);
    assertNear(resultTone.startMs, plan.cues[1].speechStartMs, 40, `${paceName}: второй PCM`);
    assertNear(clickPtsMs, clickTone.startMs, 250, `${paceName}: align-start`);
    assert.ok(
      result.startMs <= resultTone.startMs + FRAME_MS,
      `${paceName}: ready-before показывает результат не позже реплики`,
    );
    assertNear(result.startMs, resultTone.startMs, 2 * FRAME_MS, `${paceName}: ready PTS`);
    assertNear(click.endMs - click.startMs, 200, 2 * FRAME_MS, `${paceName}: клик без speed-up`);
    assertNear(
      result.startMs - click.endMs,
      2100,
      2 * FRAME_MS,
      `${paceName}: загрузка без speed-up`,
    );
    assert.ok(clickTone.endMs - clickTone.startMs >= 180, `${paceName}: первый тон не обрезан`);
    assert.ok(resultTone.endMs - resultTone.startMs >= 580, `${paceName}: конец второй фразы не обрезан`);
    const highlight = plan.highlights[0];
    const highlightedFrames = highlightRoi.filter((frame) => (
      frame.atMs + 0.01 >= highlight.startMs && frame.atMs < highlight.endMs - 0.01
    ));

    assert.ok(highlightedFrames.length >= 17, `${paceName}: рамка покрывает фразу по кадрам`);
    const dimHighlightFrames = highlightedFrames.filter((frame) => frame.y < 180 || frame.v < 90);

    assert.ok(
      dimHighlightFrames.length === 0,
      `${paceName}: рамка видна на каждом кадре связанной фразы; `
        + `highlight=${JSON.stringify(highlight)}, тусклые=${JSON.stringify(dimHighlightFrames)}`,
    );
    assertNear(states.at(-1).endMs, plan.timing.totalMs, 2 * FRAME_MS, `${paceName}: video tail`);
    assert.ok(
      decoded.durationMs >= resultTone.endMs + plan.timing.postRollMs,
      `${paceName}: AAC содержит хвост после последней реплики`,
    );
    assertNear(decoded.durationMs, plan.timing.totalMs, 100, `${paceName}: audio tail`);
  }
});

test('direct assembler отвергает подмену WAV и неотмеченный video gap', async (t) => {
  const media = await fixture(t);
  const audio = path.join(media.root, 'validation.wav');

  await makeMarkerWave(audio, PACES.normal.durationMs, []);

  const base = exactPlan(syncInput()).plan;
  const wrongAudio = structuredClone(base);

  wrongAudio.sourceAudio.sampleCount += SAMPLE_RATE / 10;
  wrongAudio.sourceAudio.durationMs += 100;

  await assert.rejects(
    buildSyncedSceneClip({
      rawVideo: media.rawVideo,
      audio,
      plan: wrongAudio,
      outFile: path.join(media.root, 'wrong-audio.mp4'),
      style: STYLE,
    }),
    /исходный WAV/i,
  );

  const cutRecording = recordingFixture();

  cutRecording.actions[1] = {
    ...cutRecording.actions[1],
    startMs: 3000,
    anchorMs: 3000,
  };
  cutRecording.removableWaits = [{
    id: 'wait-before-result',
    fromMs: 2200,
    toMs: 3000,
    beforeActionIndex: 1,
  }];

  const cutPlan = exactPlan(syncInput({ recording: cutRecording })).plan;
  const hiddenGap = { ...cutPlan, removedWaits: [] };

  await assert.rejects(
    buildSyncedSceneClip({
      rawVideo: media.rawVideo,
      audio,
      plan: hiddenGap,
      outFile: path.join(media.root, 'hidden-gap.mp4'),
      style: STYLE,
    }),
    /пропускает неотмеченную часть/i,
  );
});

test('direct assembler сохраняет каждый из восьми однокадровых hold', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-sync-eight-holds-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const rawVideo = path.join(root, 'source.mp4');
  const audio = path.join(root, 'speech.wav');
  const output = path.join(root, 'result.mp4');
  const cueCount = 8;
  const words = Array.from({ length: cueCount }, (_, index) => `слово${index}`);
  const canonicalText = words.join(' ');
  const actions = words.map(() => ({ kind: 'click' }));
  const cues = [];
  const spans = [];
  const phrases = [];
  let textOffset = 0;

  for (let index = 0; index < cueCount; index += 1) {
    const from = textOffset;
    const to = from + words[index].length;
    // +7 мс намеренно не лежит на кадровой сетке: план обязан выбрать ближайший
    // целый hold, а реальный MP4 — сохранить получившуюся погрешность, не накопить её.
    const speechStartMs = (index + 1) * 100 + (index + 1) * FRAME_MS + 7;

    cues.push({
      id: `cue-${index}`,
      actionIndex: index,
      from,
      to,
      kind: 'align-start',
      origin: 'manual',
    });
    spans.push({
      from,
      to,
      startMs: speechStartMs,
      endMs: speechStartMs + 20,
      precision: 'word',
    });
    phrases.push({
      id: `phrase-${index}`,
      from,
      to,
      startMs: speechStartMs,
      endMs: speechStartMs + 20,
    });
    textOffset = to + 1;
  }

  const recordingActions = Array.from({ length: cueCount }, (_, index) => {
    const anchorMs = (index + 1) * 100;

    return {
      actionIndex: index,
      kind: 'click',
      startMs: anchorMs - 10,
      anchorMs,
      endMs: anchorMs + 10,
      readyMs: null,
    };
  });
  const stableIntervals = Array.from({ length: cueCount }, (_, index) => {
    const anchorMs = (index + 1) * 100;

    return {
      id: `stable-${index}`,
      fromMs: index === 0 ? 0 : recordingActions[index - 1].endMs,
      toMs: recordingActions[index].startMs,
      frameMs: anchorMs - FRAME_MS,
      afterActionIndex: index === 0 ? null : index - 1,
      beforeActionIndex: index,
    };
  });

  stableIntervals.push({
    id: 'terminal',
    fromMs: recordingActions.at(-1).endMs,
    toMs: 1000,
    frameMs: 29 * FRAME_MS,
    afterActionIndex: cueCount - 1,
    beforeActionIndex: null,
  });

  const { plan } = exactPlan({
    bindingInput: {
      bindings: {
        version: 1,
        textHash: 'eight-holds-text',
        actionsHash: 'eight-holds-actions',
        cues,
      },
      canonicalText,
      actions,
      expectedTextHash: 'eight-holds-text',
      expectedActionsHash: 'eight-holds-actions',
    },
    speech: {
      canonicalText,
      durationMs: 1200,
      sampleRate: SAMPLE_RATE,
      sampleCount: 1200 * SAMPLE_RATE / 1000,
      quality: 'word-exact',
      spans,
      phrases,
      safePauses: [],
    },
    recording: {
      durationMs: 1000,
      calibration: 'fixture-exact',
      calibrationErrorMs: 0,
      actions: recordingActions,
      stableIntervals,
      removableWaits: [],
      highlights: [],
    },
    legacy: { audioMs: 1200, clipMs: 1000 },
    style: { width: STYLE.width, height: STYLE.height, fps: STYLE.fps },
    limits: { maxSceneMs: 10_000, remainingFilmMs: 10_000 },
    options: { preRollMs: 0, postRollMs: 0 },
  });

  assert.equal(plan.videoParts.filter((part) => part.kind === 'hold').length, cueCount);

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "nullsrc=s=320x180:r=30:d=1,geq=lum='16+4*N':cb=128:cr=128",
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    rawVideo,
  ]);
  await makeMarkerWave(audio, 1200, []);
  await buildSyncedSceneClip({ rawVideo, audio, plan, outFile: output, style: STYLE });

  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,duration,nb_frames,nb_read_frames:format=duration',
    '-of', 'json', output,
  ]);
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio');
  const expectedFrames = Math.round(plan.timing.totalMs / FRAME_MS);
  const sourceLumas = await readFrameLumas(rawVideo);
  const outputLumas = await readFrameLumas(output);

  assert.equal(Number(video.nb_read_frames ?? video.nb_frames), expectedFrames);
  assertNear(Number(video.duration) * 1000, plan.timing.totalMs, 1, 'eight holds: video tail');
  assertNear(Number(audioStream.duration) * 1000, plan.timing.totalMs, 2, 'eight holds: audio tail');
  assertNear(Number(probe.format.duration) * 1000, plan.timing.totalMs, 2, 'eight holds: MP4 tail');

  for (const cue of plan.cues) {
    const sourceFrame = Math.round(recordingActions[cue.actionIndex].anchorMs / FRAME_MS);
    const outputFrame = Math.round(cue.eventMs / FRAME_MS);

    assertNear(
      outputLumas[outputFrame],
      sourceLumas[sourceFrame],
      1,
      `eight holds: cue ${cue.actionIndex} сохранил исходный кадр`,
    );
    assertNear(
      cue.eventMs,
      cue.speechStartMs,
      250,
      `eight holds: cue ${cue.actionIndex} остался в допуске`,
    );
  }
});

test('direct assembler удерживает выбранные кадры до и после вырезанного ожидания', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-sync-loop-cut-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const rawVideo = path.join(root, 'source.mp4');
  const audio = path.join(root, 'speech.wav');
  const output = path.join(root, 'result.mp4');
  const atFrame = (frame) => frame * FRAME_MS;
  const videoParts = [
    {
      kind: 'hold', sourceAtMs: atFrame(0),
      outputFromMs: atFrame(0), outputToMs: atFrame(1),
      stableIntervalId: 'frame-0', cueId: 'hold-0',
    },
    {
      kind: 'source', sourceFromMs: atFrame(0), sourceToMs: atFrame(2),
      outputFromMs: atFrame(1), outputToMs: atFrame(3),
    },
    {
      kind: 'hold', sourceAtMs: atFrame(2),
      outputFromMs: atFrame(3), outputToMs: atFrame(5),
      stableIntervalId: 'frame-2', cueId: 'hold-2',
    },
    {
      kind: 'source', sourceFromMs: atFrame(2), sourceToMs: atFrame(5),
      outputFromMs: atFrame(5), outputToMs: atFrame(8),
    },
    {
      kind: 'hold', sourceAtMs: atFrame(10),
      outputFromMs: atFrame(8), outputToMs: atFrame(11),
      stableIntervalId: 'frame-10', cueId: 'hold-10',
    },
    {
      kind: 'source', sourceFromMs: atFrame(10), sourceToMs: atFrame(20),
      outputFromMs: atFrame(11), outputToMs: atFrame(21),
    },
    {
      kind: 'hold', sourceAtMs: atFrame(20),
      outputFromMs: atFrame(21), outputToMs: atFrame(22),
      stableIntervalId: 'frame-20', cueId: 'hold-20',
    },
    {
      kind: 'source', sourceFromMs: atFrame(20), sourceToMs: atFrame(30),
      outputFromMs: atFrame(22), outputToMs: atFrame(32),
    },
  ];
  const plan = {
    version: 1,
    mode: 'exact',
    timing: {
      preRollMs: 0,
      narrationStartMs: 0,
      speechEndMs: 1000,
      actionsEndMs: atFrame(32),
      postRollMs: 0,
      totalMs: atFrame(32),
    },
    sourceAudio: { sampleRate: SAMPLE_RATE, sampleCount: SAMPLE_RATE, durationMs: 1000 },
    sourceVideo: { durationMs: 1000, fps: FRAME_RATE },
    videoParts,
    audioParts: [
      {
        kind: 'source', sourceFromSample: 0, sourceToSample: SAMPLE_RATE,
        outputFromMs: 0, outputToMs: 1000,
      },
      {
        kind: 'silence', sampleCount: 3200, sampleRate: SAMPLE_RATE,
        outputFromMs: 1000, outputToMs: atFrame(32), reason: 'tail', cueId: null,
      },
    ],
    removedWaits: [{
      id: 'frames-5-9',
      sourceFromMs: atFrame(5),
      sourceToMs: atFrame(10),
      removedMs: atFrame(5),
      cueId: 'hold-10',
    }],
    highlights: [],
    cues: [],
    phrases: [],
  };

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "nullsrc=s=320x180:r=30:d=1,geq=lum='16+4*N':cb=128:cr=128",
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
    rawVideo,
  ]);
  await makeMarkerWave(audio, 1000, []);
  await buildSyncedSceneClip({ rawVideo, audio, plan, outFile: output, style: STYLE });

  const sourceLumas = await readFrameLumas(rawVideo);
  const outputLumas = await readFrameLumas(output);
  const expectedSourceFrames = [
    0, 0, 1, 2, 2, 2, 3, 4,
    10, 10, 10, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29,
  ];

  assert.equal(outputLumas.length, expectedSourceFrames.length);

  for (const [outputFrame, sourceFrame] of expectedSourceFrames.entries()) {
    assertNear(
      outputLumas[outputFrame],
      sourceLumas[sourceFrame],
      1,
      `cut+hold: выходной кадр ${outputFrame} взят из исходного ${sourceFrame}`,
    );
  }
});

test('direct assembler отвергает исходное видео длиннее плана на один кадр', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-sync-source-length-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const rawVideo = path.join(root, '31-frames.mp4');
  const audio = path.join(root, 'speech.wav');
  const output = path.join(root, 'result.mp4');
  const plan = {
    version: 1,
    mode: 'exact',
    timing: {
      preRollMs: 0,
      narrationStartMs: 0,
      speechEndMs: 1000,
      actionsEndMs: 1000,
      postRollMs: 0,
      totalMs: 1000,
    },
    sourceAudio: { sampleRate: SAMPLE_RATE, sampleCount: SAMPLE_RATE, durationMs: 1000 },
    sourceVideo: { durationMs: 1000, fps: FRAME_RATE },
    videoParts: [{
      kind: 'source',
      sourceFromMs: 0,
      sourceToMs: 1000,
      outputFromMs: 0,
      outputToMs: 1000,
    }],
    audioParts: [{
      kind: 'source',
      sourceFromSample: 0,
      sourceToSample: SAMPLE_RATE,
      outputFromMs: 0,
      outputToMs: 1000,
    }],
    removedWaits: [],
    highlights: [],
    cues: [],
    phrases: [],
  };

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1.033333',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    rawVideo,
  ]);
  await makeMarkerWave(audio, 1000, []);

  await assert.rejects(
    buildSyncedSceneClip({ rawVideo, audio, plan, outFile: output, style: STYLE }),
    (error) => error?.code === 'assemble_failed',
  );
});

test('direct assembler исполняет соседние удаления из точного planner', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-sync-adjacent-cuts-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const rawVideo = path.join(root, 'source.mp4');
  const audio = path.join(root, 'speech.wav');
  const output = path.join(root, 'result.mp4');
  const canonicalText = 'слово';
  const actions = [{ kind: 'click' }, { kind: 'click' }];
  const cues = actions.map((_, actionIndex) => ({
    id: `cue-${actionIndex}`,
    actionIndex,
    from: 0,
    to: canonicalText.length,
    kind: 'align-start',
    origin: 'manual',
  }));
  const { plan } = exactPlan({
    bindingInput: {
      bindings: {
        version: 1,
        textHash: 'adjacent-text',
        actionsHash: 'adjacent-actions',
        cues,
      },
      canonicalText,
      actions,
      expectedTextHash: 'adjacent-text',
      expectedActionsHash: 'adjacent-actions',
    },
    speech: {
      canonicalText,
      durationMs: 100,
      sampleRate: SAMPLE_RATE,
      sampleCount: 4800,
      quality: 'word-exact',
      spans: [{
        from: 0, to: canonicalText.length, startMs: 0, endMs: 20, precision: 'word',
      }],
      phrases: [{ id: 'phrase', from: 0, to: canonicalText.length, startMs: 0, endMs: 20 }],
      safePauses: [],
    },
    recording: {
      durationMs: 300,
      calibration: 'fixture-exact',
      calibrationErrorMs: 0,
      actions: [
        { actionIndex: 0, kind: 'click', startMs: 100, anchorMs: 100, endMs: 100, readyMs: null },
        { actionIndex: 1, kind: 'click', startMs: 200, anchorMs: 200, endMs: 200, readyMs: null },
      ],
      stableIntervals: [{
        id: 'terminal', fromMs: 200, toMs: 300, frameMs: 800 / 3,
        afterActionIndex: 1, beforeActionIndex: null,
      }],
      removableWaits: [
        { id: 'first', fromMs: 0, toMs: 100, beforeActionIndex: 0 },
        { id: 'second', fromMs: 100, toMs: 200, beforeActionIndex: 1 },
      ],
      highlights: [],
    },
    legacy: { audioMs: 100, clipMs: 300 },
    style: { width: STYLE.width, height: STYLE.height, fps: STYLE.fps },
    limits: { maxSceneMs: 10_000, remainingFilmMs: 10_000 },
    options: { preRollMs: 0, postRollMs: 0 },
  });

  assert.equal(plan.removedWaits.length, 2);
  assert.equal(plan.videoParts[0].sourceFromMs, 200);

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=0.3',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    rawVideo,
  ]);
  await makeMarkerWave(audio, 100, []);
  await buildSyncedSceneClip({ rawVideo, audio, plan, outFile: output, style: STYLE });

  assert.equal((await readFrameLumas(output)).length, 3);
});
