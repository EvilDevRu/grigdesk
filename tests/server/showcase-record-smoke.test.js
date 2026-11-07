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
import { READY_MARGIN_MS, trimSceneClip } from '../../server/src/lib/showcase/render/clipTrim.ts';
import { launchBrowser, loginToStand, recordScene } from '../../server/src/lib/showcase/render/recorder.ts';

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
  if (process.env.GRIGDESK_SHOWCASE_BROWSER) {
    return process.env.GRIGDESK_SHOWCASE_BROWSER;
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
  // Данные приходят второй волной: запрос уходит через полсекунды после
  // готовности каркаса и отвечает не сразу — как таблица позиций на стенде.
  const dataRequests = [];
  const target = http.createServer((request, response) => {
    if (request.url === '/data') {
      dataRequests.push(request.url);
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"rows":3}');
      }, 300);

      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Стенд</title>
<style>body{margin:0;background:#0f1115;color:#e8ecf1;font:16px system-ui}main{padding:48px}</style>
</head><body><main>
<h1 data-testid="ready">Готовый экран</h1>
<button data-testid="run">Запустить</button>
<img src="${outsideOrigin}/pixel.png" alt="" width="1" height="1">
<script>
fetch('${outsideOrigin}/fetch').catch(() => {});
setTimeout(() => {
  fetch('/data').then((r) => r.json()).then((data) => {
    const p = document.createElement('p');
    p.dataset.testid = 'loaded';
    p.textContent = 'строк: ' + data.rows;
    document.querySelector('main').append(p);
  });
}, 500);
</script>
</main></body></html>`);
  });

  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));

  return {
    targetOrigin: `http://127.0.0.1:${target.address().port}`,
    outsideOrigin,
    outsideRequests,
    dataRequests,
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

  // Сцена дождалась второй волны данных и затишья после действий: спокойный
  // стенд не упирается в предел, точка готовности сдвинута за конец волны
  // (полсекунды до запроса, 300 мс ответа, секунда затишья), а после действий
  // записано не меньше самих действий плюс затишье.
  assert.equal(recorded.unsettled, 0, 'затишье сети обязано наступить на спокойном стенде');
  assert.equal(targets.dataRequests.length, 1, 'вторая волна данных ушла на стенд во время сцены');
  assert.ok(
    recorded.readyOffsetMs >= 1800,
    `готовность наступила раньше конца волны данных: ${recorded.readyOffsetMs} мс`,
  );
  assert.ok(
    recorded.recordedMs - recorded.readyOffsetMs >= 1600,
    `после готовности записано лишь ${recorded.recordedMs - recorded.readyOffsetMs} мс`,
  );

  // Обрезка до готовности: загрузка страницы в клип не входит, всё после неё —
  // входит.
  const trimmed = await trimSceneClip({
    rawPath: recorded.rawPath,
    startMs: Math.max(0, recorded.readyOffsetMs - READY_MARGIN_MS),
    outFile: path.join(outDir, 'ready.webm'),
  });
  const trimmedCheck = await checkSceneClip(trimmed);

  assert.equal(trimmedCheck.ok, true, trimmedCheck.reason);
  assert.ok(trimmedCheck.durationMs < check.durationMs, 'обрезанный клип короче исходной записи');
  assert.ok(
    trimmedCheck.durationMs >= recorded.recordedMs - recorded.readyOffsetMs - 200,
    `в обрезанном клипе должно остаться всё после готовности: ${trimmedCheck.durationMs} мс`,
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

/**
 * Стенд, который не принимает учётку: форма отправляется и рисуется заново без
 * признака входа. Ровно так выглядит холодный или отвергший пароль стенд.
 */
async function startRejectingStand() {
  const server = http.createServer((request, response) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Вход</title></head>
<body><main>
<form method="post" action="/login">
<input id="email" name="email"><input id="password" name="password" type="password">
<button type="submit">Войти</button>
</form>
${body ? '<p class="error">Неверный пароль</p>' : ''}
</main></body></html>`);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Первая сорвавшаяся запись ролика осталась с причиной «locator.waitFor: Timeout» —
// без адреса, без формы и без снимка. Отказ входа обязан говорить, что увидел браузер.
test('несостоявшийся вход называет форму на экране и оставляет снимок', async (t) => {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен: это не успешная приёмка, а её отсутствие');

    return;
  }

  const outDir = await mkdtemp(path.join(os.tmpdir(), 'showcase-login-'));
  const stand = await startRejectingStand();
  const guard = await startEgressGuard({
    allowedOrigins: [stand.origin],
    allowedMethods: ['GET', 'HEAD', 'POST'],
  });

  t.after(async () => {
    await guard.close();
    await stand.close();
    await rm(outDir, { recursive: true, force: true });
  });

  const browser = await launchBrowser({ executablePath: browserPath, proxyPort: guard.port });

  t.after(() => browser.close());

  await assert.rejects(
    () => loginToStand({
      browser,
      baseUrl: stand.origin,
      allowedOrigins: [stand.origin],
      style: STYLE,
      login: {
        url: '/login',
        userSelector: '#email',
        passwordSelector: '#password',
        submitSelector: 'button[type="submit"]',
        readySelector: 'a[href="/logout"]',
        user: 'demo@example.test',
        password: 'secret',
      },
      timeoutMs: 3_000,
      diagnosticsDir: outDir,
    }),
    (error) => {
      assert.equal(error.code, 'login_failed');
      assert.match(error.message, /форма входа осталась на экране \(http:\/\/127\.0\.0\.1:\d+\/login\)/);
      assert.match(error.message, /«a\[href="\/logout"\]» не появилось за 3 с/);
      assert.doesNotMatch(error.message, /locator\.waitFor/, 'сырой текст Playwright наружу не уходит');
      assert.match(error.message, /login-failed\.jpg/);

      return true;
    },
  );
  await access(path.join(outDir, 'login-failed.jpg'));
});
