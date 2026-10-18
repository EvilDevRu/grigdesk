// Изолированная приёмка шкалы записи: marker transitions живут только вокруг
// пользовательских кадров, а browser-monotonic события переводятся в настоящий PTS.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { startEgressGuard } from '../../server/src/lib/showcase/browserPolicy.ts';
import {
  browserMonoToVideoPts,
  calibrateVideoTiming,
  probeVideoFrameSignatures,
  stableFrameRunsOf,
  trimSceneClipExact,
  videoContainsCalibrationMarker,
} from '../../server/src/lib/showcase/render/clipTrim.ts';
import { launchBrowser, recordChain } from '../../server/src/lib/showcase/render/recorder.ts';
import {
  publishRecordingTiming,
  readRecordingTiming,
} from '../../server/src/lib/showcase/recordingOps.ts';

const STYLE = {
  width: 960,
  height: 540,
  fps: 30,
  theme: 'dark',
  locale: 'ru-RU',
  burnSubtitles: false,
};

async function findBrowser() {
  if (process.env.GRIGDESK_SHOWCASE_BROWSER) {
    return process.env.GRIGDESK_SHOWCASE_BROWSER;
  }

  const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
  const registry = path.join(os.homedir(), '.cache', 'ms-playwright');

  try {
    const entry = requireFromServer.resolve('playwright-core');
    const browsers = JSON.parse(await readFile(path.join(path.dirname(entry), 'browsers.json'), 'utf8'));
    const wanted = browsers.browsers.find((item) => item.name === 'chromium');
    const candidate = path.join(registry, `chromium-${wanted.revision}`, 'chrome-linux64', 'chrome');

    return access(candidate).then(() => candidate).catch(() => null);
  } catch {
    return null;
  }
}

async function startStand() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#172033;color:white;font:18px sans-serif}main{padding:40px;height:1200px}
#result{display:none;margin-top:700px;width:300px;height:80px;background:#16803a;padding:20px}
</style></head><body><main><h1 data-testid="ready">Timing stand</h1>
<button data-testid="open">Open</button><div id="result" data-testid="result">READY RESULT</div>
<script>document.querySelector('[data-testid="open"]').addEventListener('click',()=>{
setTimeout(()=>{document.querySelector('#result').style.display='block'},260)})</script>
</main></body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function scene() {
  return {
    id: 'scene-timing', order: 1, title: 'Timing', screenId: 'timing',
    startState: null, readyCondition: null,
    actions: [
      { kind: 'click', targetId: 'open' },
      { kind: 'waitVisible', targetId: 'result' },
      { kind: 'highlight', targetId: 'result' },
    ],
    narration: 'Открываем результат.', caption: '', subtitleText: 'Открываем результат.',
    direction: { tone: null, pace: null, emphasis: [], pauses: [], stresses: [] },
    timing: null, syncBindings: null, speechTiming: null, recordingTiming: null,
    audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
    audio: null, clip: null, frame: null, checks: [], stale: true,
  };
}

test('recordingTiming публикуется атомарно и битый JSON старит только журнал', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-recording-json-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const actions = [{ kind: 'click', targetId: 'open' }];
  const timing = {
    status: 'calibrated',
    durationMs: 1000,
    sceneReadyMs: 100,
    calibration: {
      method: 'visual-marker-affine-v1',
      errorMs: 40,
      startErrorMs: 35,
      endErrorMs: 40,
      rate: 1.0001,
    },
    actions: [{
      actionIndex: 0,
      kind: 'click',
      startMs: 200,
      anchorMs: 250,
      endMs: 300,
      readyMs: null,
      geometry: { x: 10, y: 20, width: 100, height: 40 },
    }],
    stableIntervals: [{
      id: 'stable-tail', fromMs: 300, toMs: 1000, frameMs: 300,
      afterActionIndex: 0, beforeActionIndex: null,
    }],
    removableWaits: [],
    highlights: [],
  };
  const ref = await publishRecordingTiming({
    timing,
    sceneInputHash: 'scene-input',
    clipContentHash: 'clip-content',
    actions,
    targetDir: dir,
  });

  assert.ok(ref);
  const readInput = {
    ref,
    sceneInputHash: 'scene-input',
    clipContentHash: 'clip-content',
    actions,
    targetDir: dir,
  };

  const decoded = await readRecordingTiming(readInput);

  assert.ok(decoded);
  assert.deepEqual(decoded, {
    version: 1,
    clipContentHash: 'clip-content',
    actionsHash: decoded.actionsHash,
    producerVersion: 'recorder-6',
    ...timing,
  });
  assert.equal(await readRecordingTiming({ ...readInput, clipContentHash: 'other' }), null);

  await writeFile(path.join(dir, `${ref.id}.json`), '{broken', 'utf8');
  assert.equal(await readRecordingTiming(readInput), null);
  assert.equal(await publishRecordingTiming({
    timing: { ...timing, durationMs: 999 },
    sceneInputHash: 'scene-input',
    clipContentHash: 'clip-content',
    actions,
    targetDir: dir,
  }), null);

  const unavailable = {
    status: 'unavailable',
    durationMs: 1000,
    calibration: {
      method: 'visual-marker-affine-v1',
      reason: 'Контрольная отметка намеренно отсутствует.',
    },
  };
  const unavailableRef = await publishRecordingTiming({
    timing: unavailable,
    sceneInputHash: 'scene-input',
    clipContentHash: 'clip-content',
    actions,
    targetDir: dir,
  });

  assert.ok(unavailableRef, 'неудачная калибровка сохраняется как явный результат попытки');
  const unavailableDocument = await readRecordingTiming({
    ...readInput,
    ref: unavailableRef,
  });

  assert.ok(unavailableDocument);
  assert.equal(unavailableDocument.status, 'unavailable');
  if (unavailableDocument.status === 'unavailable') {
    assert.equal(unavailableDocument.calibration.reason, unavailable.calibration.reason);
  }
});

test('visual marker связывает browser monotonic с PTS и не попадает в CFR-клип', async (t) => {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен');
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-record-timing-'));
  const stand = await startStand();
  const guard = await startEgressGuard({
    allowedOrigins: [stand.origin],
    allowedMethods: ['GET', 'HEAD'],
  });
  const browser = await launchBrowser({ executablePath: browserPath, proxyPort: guard.port });

  t.after(async () => {
    await browser.close();
    await guard.close();
    await stand.close();
    await rm(dir, { recursive: true, force: true });
  });

  const recorded = await recordChain({
    browser,
    scenes: [{
      scene: scene(),
      screen: {
        id: 'timing', path: '/', readySelector: '[data-testid="ready"]',
        elements: [
          { id: 'open', selector: '[data-testid="open"]' },
          { id: 'result', selector: '[data-testid="result"]' },
        ],
      },
    }],
    baseUrl: stand.origin,
    allowedOrigins: [stand.origin],
    outDir: dir,
    style: STYLE,
    loginState: null,
    timingMode: 'measured',
    settleQuietMs: 250,
    settleCapMs: 2_000,
  });
  const calibration = await calibrateVideoTiming(recorded.rawPath, recorded.calibration ?? []);

  assert.equal(calibration.status, 'calibrated', calibration.reason);

  if (calibration.status !== 'calibrated') return;

  assert.ok(calibration.startErrorMs <= 100);
  assert.ok(calibration.endErrorMs <= 100);

  const mark = recorded.scenes[0];
  assert.ok(mark?.readyMonoMs && mark.finishedMonoMs);
  assert.equal(mark.actions?.length, 3);

  const startPtsMs = Math.max(
    calibration.headExcludedBeforePtsMs,
    browserMonoToVideoPts(calibration, mark.readyMonoMs) - 400,
  );
  const endPtsMs = Math.min(
    calibration.tailExcludedFromPtsMs,
    browserMonoToVideoPts(calibration, mark.finishedMonoMs),
  );
  const trimmed = await trimSceneClipExact({
    rawPath: recorded.rawPath,
    startPtsMs,
    endPtsMs,
    fps: STYLE.fps,
    outFile: path.join(dir, 'scene.webm'),
  });

  assert.ok(trimmed.frameCount > 10);
  assert.ok(Math.abs(trimmed.durationMs - trimmed.frameCount * 1000 / STYLE.fps) < 1e-9);
  assert.equal(
    await videoContainsCalibrationMarker(trimmed.path, recorded.calibration ?? []),
    false,
  );
  const runs = stableFrameRunsOf(await probeVideoFrameSignatures(trimmed.path), { minFrames: 5 });

  assert.ok(runs.length > 0, 'у неподвижного стенда есть устойчивые серии кадров');

  for (const action of mark.actions ?? []) {
    const localAnchor = browserMonoToVideoPts(calibration, action.anchorMonoMs)
      - trimmed.firstRetainedSourcePtsMs + trimmed.outputFirstPtsMs;

    assert.ok(localAnchor >= 0 && localAnchor <= trimmed.durationMs, `${action.kind}: ${localAnchor}`);
  }

  // Перед действием, меняющим экран, запись отдыхает: монтажу нужен измеренный
  // устойчивый интервал ПЕРЕД действием, а вплотную идущие действия его не
  // оставляли. Перед ожиданием паузы нет — иначе готовность результата измерялась
  // бы позже настоящей.
  const [click, waitVisible, highlight] = mark.actions ?? [];

  assert.ok(
    waitVisible.startMonoMs - click.endMonoMs < 450,
    `click → waitVisible: пауза ${Math.round(waitVisible.startMonoMs - click.endMonoMs)} мс`,
  );
  assert.ok(
    highlight.startMonoMs - waitVisible.endMonoMs >= 450,
    `waitVisible → highlight: пауза ${Math.round(highlight.startMonoMs - waitVisible.endMonoMs)} мс`,
  );
});

// Серии считаются от опорного кадра с допуском: codec noise VP9 не рвёт неподвижный
// экран, а плавное затухание и курсор серию заканчивают.
test('stableFrameRunsOf: шум кодека не рвёт серию, дрейф и курсор — рвут', () => {
  const size = 64 * 36;
  const frame = (index, fill, patch = null) => {
    const pixels = new Uint8Array(size).fill(fill);

    if (patch) {
      pixels[patch.at] = patch.value;
    }

    return { index, ptsMs: index * 1000 / 30, pixels };
  };

  const noisy = Array.from({ length: 12 }, (_, index) => frame(
    index,
    // Соседние кадры пляшут в пределах ±2 вокруг опорного значения.
    128 + [0, 2, -2, 1, -1, 2, 0, -2, 1, 2, -1, 0][index],
  ));

  assert.deepEqual(stableFrameRunsOf(noisy, { minFrames: 5 }), [{ fromIndex: 0, toIndex: 11 }]);

  // Затухание на уровень за кадр: относительно предыдущего кадра оно «в допуске»,
  // относительно опорного — уходит за него на четвёртом кадре.
  const fade = Array.from({ length: 12 }, (_, index) => frame(index, 128 + index));

  assert.deepEqual(stableFrameRunsOf(fade, { minFrames: 3 }), [
    { fromIndex: 0, toIndex: 3 },
    { fromIndex: 4, toIndex: 7 },
    { fromIndex: 8, toIndex: 11 },
  ]);

  // Один пиксель курсора на неподвижном фоне — уже другое состояние экрана.
  const cursor = [
    ...Array.from({ length: 6 }, (_, index) => frame(index, 128)),
    ...Array.from({ length: 6 }, (_, index) => frame(6 + index, 128, { at: 700, value: 180 })),
  ];

  assert.deepEqual(stableFrameRunsOf(cursor, { minFrames: 5 }), [
    { fromIndex: 0, toIndex: 5 },
    { fromIndex: 6, toIndex: 11 },
  ]);

  // Серия короче минимума не публикуется.
  assert.deepEqual(stableFrameRunsOf(cursor.slice(0, 4), { minFrames: 5 }), []);
});
