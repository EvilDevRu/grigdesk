// Живая приёмка двух случаев, когда цель действия есть в DOM, но не на экране.
//
// Прокрутка к цели за кромкой кадра: запись дожидается КОНЦА плавной прокрутки, а
// не первого затишья. Стенд откладывает старт плавной прокрутки на 300 мс — так
// ведёт себя тяжёлая страница с открытым диалогом (размытие фона, ~11 кадров в
// секунду), на которой цепочка ролика срывалась «цель за границей кадра»: два
// одинаковых замера ДО начала движения принимались за остановку, и регион в шапке
// оставался за верхней кромкой. Мгновенная прокрутка остаётся мгновенной — как в
// браузере.
//
// Цель, видимая только при наведении: иконка в заголовке колонки появляется по
// `:hover` родителя, и без указателя рядом подсветка срывалась «не видна на экране».
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { startEgressGuard } from '../../server/src/lib/showcase/browserPolicy.ts';
import { launchBrowser, recordChain } from '../../server/src/lib/showcase/render/recorder.ts';

const STYLE = {
  width: 960,
  height: 540,
  fps: 30,
  theme: 'dark',
  locale: 'ru-RU',
  burnSubtitles: false,
};

// Кнопка в шапке страницы: при нулевой прокрутке стоит на этой высоте.
const REGION_TOP = 10;

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

/**
 * Страница со своим прокручиваемым `main`, как у стенда позиций: шапка с кнопкой
 * региона наверху, таблица ниже первого экрана. Плавная прокрутка стартует с
 * задержкой, мгновенная — сразу.
 */
async function startStand() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#172033;color:white;font:18px sans-serif}
main{height:100vh;overflow-y:auto}
header{height:60px;background:#243b6b}
#region{position:relative;top:${REGION_TOP}px;margin-left:24px}
.spacer{height:700px}
.row{padding:8px 24px;border-bottom:1px solid #2c4a80}
.cell{display:inline-block;padding:12px 24px;background:#243b6b}
.cell .gear{display:none;margin-left:12px}
.cell:hover .gear{display:inline-block}
</style></head><body><main>
<header><button id="region" data-testid="region">Регион</button></header>
<div class="spacer"></div>
<h2 id="table" data-testid="table">Таблица</h2>
<div class="cell" data-testid="cell">Частота<button class="gear" data-testid="gear">⚙</button></div>
${Array.from({ length: 40 }, (_, index) => `<div class="row">строка ${index + 1}</div>`).join('')}
</main><script>
const original = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = function (options) {
  if (options && options.behavior === 'smooth') {
    setTimeout(() => original.call(this, options), 300);
    return;
  }
  return original.call(this, options);
};
</script></body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function scene(actions) {
  return {
    id: 'scene-reveal', order: 1, title: 'Reveal', screenId: 'positions',
    startState: null, readyCondition: null,
    actions,
    narration: 'Регион в шапке.', caption: '', subtitleText: 'Регион в шапке.',
    direction: { tone: null, pace: null, emphasis: [], pauses: [], stresses: [] },
    timing: null, syncBindings: null, speechTiming: null, recordingTiming: null,
    audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
    audio: null, clip: null, frame: null, checks: [], stale: true,
  };
}

/** Живой стенд, ограничитель и браузер на один тест; запись одной сцены с действиями. */
async function recordActions(t, actions) {
  const browserPath = await findBrowser();

  if (!browserPath) {
    t.skip('браузер записи не установлен');
    return null;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-record-reveal-'));
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
      scene: scene(actions),
      screen: {
        id: 'positions', path: '/', readySelector: '[data-testid="table"]',
        elements: [
          { id: 'region', selector: '[data-testid="region"]' },
          { id: 'table', selector: '[data-testid="table"]' },
          { id: 'cell', selector: '[data-testid="cell"]' },
          { id: 'gear', selector: '[data-testid="gear"]' },
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

  return recorded.scenes[0];
}

test('подсветка цели за верхней кромкой дожидается конца плавной прокрутки', async (t) => {
  const mark = await recordActions(t, [
    { kind: 'hover', targetId: 'table' },
    { kind: 'highlight', targetId: 'region' },
  ]);

  if (!mark) {
    return;
  }

  assert.equal(mark?.actions?.length, 2);

  // Наведение на таблицу увело шапку за верхнюю кромку: таблица встала в центр.
  const table = mark.actions[0].geometry;

  assert.ok(table, 'у наведения нет геометрии');
  assert.ok(
    table.y > STYLE.height * 0.15 && table.y + table.height < STYLE.height * 0.85,
    `таблица: ${table.y}`,
  );

  // Подсветка региона снята после того, как прокрутка вернула шапку на место, —
  // не раньше начала движения и не на полпути.
  const region = mark.actions[1].geometry;

  assert.ok(region, 'у подсветки нет геометрии');
  assert.ok(Math.abs(region.y - REGION_TOP) <= 2, `регион: ${region.y}`);
  assert.equal(mark.highlights?.length, 1);
  assert.ok(Math.abs(mark.highlights[0].geometry.y - REGION_TOP) <= 2);
});

test('цель, видимая только при наведении, получает указатель на родителя', async (t) => {
  const mark = await recordActions(t, [
    { kind: 'highlight', targetId: 'gear' },
  ]);

  if (!mark) {
    return;
  }

  assert.equal(mark?.actions?.length, 1);

  // Иконка скрыта, пока указатель не над ячейкой: запись сама подвела его туда,
  // и рамка снята с появившейся иконки — внутри ячейки, ненулевого размера.
  const gear = mark.actions[0].geometry;

  assert.ok(gear, 'у подсветки нет геометрии');
  assert.ok(gear.width > 0 && gear.height > 0);
  assert.ok(gear.y >= 0 && gear.y + gear.height <= STYLE.height, `иконка: ${gear.y}`);
  assert.equal(mark.highlights?.length, 1);
});
