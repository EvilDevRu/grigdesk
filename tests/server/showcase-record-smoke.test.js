// Живая проверка записи: настоящий браузер, настоящий стенд-мишень, настоящий
// ограничитель сети.
//
// Отсутствие браузера НЕ считается успехом: тест в этом случае пропускается явно,
// с причиной. Иначе «зелёный» прогон на машине без зависимости выглядел бы как
// доказательство работающей записи.
//
// Проверяется то, что заход 0 выяснил про запись: клип не пустой, подготовительные
// кадры в него не попали, а запрещённый адрес не получил ни одного запроса — при
// том, что попытка к нему была настоящей.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { startEgressGuard } from '../../server/src/lib/showcase/browserPolicy.ts';
import { checkSceneClip } from '../../server/src/lib/showcase/render/clipCheck.ts';
import { launchBrowser, recordScene } from '../../server/src/lib/showcase/render/recorder.ts';

const STYLE = {
  width: 1280,
  height: 720,
  fps: 30,
  theme: 'dark',
  locale: 'ru-RU',
  burnSubtitles: false,
};

const SCREEN = {
  id: 'overview',
  path: '/',
  readySelector: '[data-testid="ready"]',
  elements: [{ id: 'run', selector: '[data-testid="run"]' }],
};

/**
 * Ищет браузер записи. Явный адрес сильнее: ревизия из кэша Playwright подходит
 * только той версии библиотеки, которая её и просила.
 */
async function findBrowser() {
  if (process.env.COCKPIT_SHOWCASE_BROWSER) {
    return process.env.COCKPIT_SHOWCASE_BROWSER;
  }

  // Список ревизий лежит в самом пакете, но его подпуть не объявлен в exports:
  // читаем файл рядом с точкой входа, а не через резолвер модулей.
  const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
  const registry = path.join(os.homedir(), '.cache', 'ms-playwright');
  const browsers = await (async () => {
    try {
      const entry = requireFromServer.resolve('playwright-core');
      const file = path.join(path.dirname(entry), 'browsers.json');

      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  })();
  const wanted = browsers?.browsers?.find((item) => item.name === 'chromium');

  if (!wanted) {
    return null;
  }

  const candidate = path.join(registry, `chromium-${wanted.revision}`, 'chrome-linux64', 'chrome');

  return access(candidate).then(() => candidate).catch(() => null);
}

/**
 * Стенд-мишень и «внешний» сервер, на который сцене ходить нельзя. Журнал ведут оба:
 * приёмка сетевой границы читается по журналу запрещённого сервера, а не по тому,
 * что страница поймала в catch.
 */
async function startTargets() {
  const outsideRequests = [];
  const outside = http.createServer((request, response) => {
    outsideRequests.push(request.url);
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('сюда нельзя');
  });

  await new Promise((resolve) => outside.listen(0, '127.0.0.1', resolve));

  const outsideOrigin = `http://127.0.0.1:${outside.address().port}`;
  const target = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Стенд</title>
<style>body{margin:0;background:#0f1115;color:#e8ecf1;font:16px system-ui}main{padding:48px}</style>
</head><body><main>
<h1 data-testid="ready">Готовый экран</h1>
<button data-testid="run">Запустить</button>
<img src="${outsideOrigin}/pixel.png" alt="" width="1" height="1">
<script>fetch('${outsideOrigin}/fetch').catch(() => {});</script>
</main></body></html>`);
  });

  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));

  return {
    targetOrigin: `http://127.0.0.1:${target.address().port}`,
    outsideOrigin,
    outsideRequests,
    close: async () => {
      await new Promise((resolve) => target.close(resolve));
      await new Promise((resolve) => outside.close(resolve));
    },
  };
}

function sceneFixture() {
  return {
    id: 'scene-smoke',
    order: 1,
    title: 'Живая проверка',
    screenId: 'overview',
    startState: null,
    readyCondition: null,
    actions: [
      { kind: 'hover', targetId: 'run' },
      { kind: 'wait', ms: 700 },
    ],
    narration: 'Проверяем запись.',
    caption: 'Проверка',
    subtitleText: 'Проверяем запись.',
    direction: {
      tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
    },
    timing: null,
    audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
    audio: null,
    clip: null,
    frame: null,
    checks: [],
    stale: true,
  };
}

test('запись сцены даёт непустой клип и не выпускает запросы за границу', async (t) => {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен: это не успешная приёмка, а её отсутствие');

    return;
  }

  const outDir = await mkdtemp(path.join(os.tmpdir(), 'showcase-record-'));
  const targets = await startTargets();
  const guard = await startEgressGuard({
    allowedOrigins: [targets.targetOrigin],
    allowedMethods: ['GET', 'HEAD'],
  });

  t.after(async () => {
    await guard.close();
    await targets.close();
    await rm(outDir, { recursive: true, force: true });
  });

  const browser = await launchBrowser({ executablePath: browserPath, proxyPort: guard.port });

  t.after(() => browser.close());

  const recorded = await recordScene({
    browser,
    scene: sceneFixture(),
    screen: SCREEN,
    baseUrl: targets.targetOrigin,
    allowedOrigins: [targets.targetOrigin],
    outDir,
    style: STYLE,
    loginState: null,
    deadlineMs: 90_000,
  });
  const check = await checkSceneClip(recorded.rawPath);

  assert.equal(check.ok, true, check.reason);
  assert.ok(check.durationMs > 200, 'клип короче четверти секунды записью не считается');
  assert.ok(
    check.flatFrames < check.sampledFrames,
    'в клипе обязана быть картинка, а не однотонный лист',
  );

  assert.deepEqual(
    targets.outsideRequests,
    [],
    'на запрещённый адрес не должно уйти ни одного запроса',
  );
  assert.ok(
    guard.blocked.length > 0,
    'попытка выхода была настоящей: ограничитель обязан её увидеть',
  );
});
