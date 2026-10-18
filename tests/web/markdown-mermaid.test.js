import assert from 'node:assert/strict';
import test from 'node:test';

import { createMermaidRenderer, mermaidThemeVariables, svgToImage }
  from '../../web/src/shared/markdown/mermaidRender.ts';
import { installUiBrowser } from './helpers/ui-components.js';

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">';
const safe = `${SVG_OPEN}<path d="M0 0L10 10"/></svg>`;

test('RMD-MM-01: SVG root и безопасные ресурсы проверяются до data URL', async (t) => {
  const browser = await installUiBrowser(t);

  assert.equal(Boolean(svgToImage(safe, browser.document)), true);

  for (const svg of [
    '<html/>', '<svg><broken></svg>', `<!DOCTYPE svg>${safe}`, `${SVG_OPEN}<script>alert(1)</script></svg>`,
    `${SVG_OPEN}<path onload="alert(1)"/></svg>`, `${SVG_OPEN}<foreignObject><p>x</p></foreignObject></svg>`,
    `${SVG_OPEN}<image href="https://evil.test/pixel"/></svg>`,
    `${SVG_OPEN}<a href="javascript:alert(1)">x</a></svg>`,
    `${SVG_OPEN}<style>path { fill: url(https://evil.test/a); }</style></svg>`,
    `${SVG_OPEN}<style>@import 'https://evil.test/a';</style></svg>`,
  ]) {
    assert.equal(svgToImage(svg, browser.document), null, svg.slice(0, 160));
  }
});

test('RMD-MM-02: размеры чата округлены, natural размер 2×', async (t) => {
  const browser = await installUiBrowser(t);
  const image = svgToImage('<svg xmlns="http://www.w3.org/2000/svg"' +
    ' viewBox="0 0 179.7 474.6" width="100%" style="max-width: 179.7px"></svg>', browser.document);

  assert.equal(image?.width, 180);
  assert.equal(image?.height, 475);

  const svg = decodeURIComponent(image.src.split(',')[1]);

  assert.match(svg, /width="360"/);
  assert.match(svg, /height="950"/);
  assert.doesNotMatch(svg, /max-width/);
});

test('RMD-MM-03: viewBox и размер результата ограничены, внутренние ресурсы разрешены', async (t) => {
  const browser = await installUiBrowser(t);

  for (const box of ['', '0 0 0 1', '0 0 -1 3', '0 0 NaN 1', '0 0 Infinity 2',
    'NaN 0 10 10', '0 0 2000.1 1999.9', '0 0 4097 1', '0 0 3000 3000', '0 0 2 3 4']) {
    assert.equal(svgToImage(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"/>`,
      browser.document), null, box);
  }

  assert.equal(svgToImage(safe + ' '.repeat(2_000_000), browser.document), null);
  assert.equal(Boolean(svgToImage(`${SVG_OPEN}<defs><marker id="m"/><linearGradient id="g"/></defs>` +
    '<path marker-end="url(#m)" fill="url(\'\#g\')"/><use href="#m"/></svg>', browser.document)), true);
});

test('RMD-MM-04: тема и протокол содержат только allowlist цветов', async (t) => {
  const defaults = mermaidThemeVariables();

  assert.equal(defaults.primaryColor, '#151b24');
  assert.equal(defaults.primaryTextColor, '#e7eaf0');
  assert.equal(defaults.lineColor, '#5aa2ff');
  assert.equal(Object.hasOwn(defaults, 'themeCSS'), false);

  // Доли круговой и строки атрибутов ER иначе выводятся Mermaid из тёмного primaryColor.
  const pies = ['pie1', 'pie2', 'pie3', 'pie4', 'pie5', 'pie6'].map((key) => defaults[key]);

  assert.equal(pies.every(Boolean), true);
  assert.equal(new Set(pies).size, pies.length);
  assert.equal(defaults.rowOdd, '#151b24');
  assert.equal(defaults.rowEven, '#1c222c');

  const browser = await installUiBrowser(t);

  browser.document.documentElement.style.setProperty('--good', '#00ff00');
  assert.equal(mermaidThemeVariables(browser.document).pie2, '#00ff00');

  browser.document.documentElement.style.setProperty('--accent', '#abcdef');
  assert.equal(mermaidThemeVariables(browser.document).lineColor, '#abcdef');
  browser.document.documentElement.style.setProperty('--accent', 'url(https://evil.test/x)');
  assert.equal(mermaidThemeVariables(browser.document).lineColor, defaults.lineColor);
});

/**
 * Посылает событие из выбранного окна, как его получает production родитель.
 * Протокольная проверка не исполняет Mermaid и не подменяет правила обработки сообщений.
 */
function receive(browser, source, data) {
  browser.dispatchEvent(new browser.MessageEvent('message', { source, data }));
}

test('RMD-MM-05: только ответ своего frame с текущим requestId публикуется', async (t) => {
  const browser = await installUiBrowser(t);

  browser.happyDOM.settings.disableJavaScriptFileLoading = true;
  browser.happyDOM.settings.disableJavaScriptEvaluation = true;

  const client = createMermaidRenderer({
    document: browser.document,
    rendererUrl: 'https://grigdesk.test/assets/mermaid.js',
    loadRenderer: () => new Promise(() => {}),
    timeoutMs: 2000,
  });

  t.after(() => client.dispose());

  let completed = false;
  const pending = client.render('flowchart TD\n A-->B').then((result) => {
    completed = true;

    return result;
  });
  const frame = browser.document.querySelector('iframe');

  assert.equal(Boolean(frame), true);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.match(frame.srcdoc, /connect-src 'none'/);
  assert.doesNotMatch(frame.srcdoc, /allow-same-origin|unsafe-eval/);

  const posts = [];
  const peer = { postMessage: (data) => posts.push(data) };

  Object.defineProperty(frame, 'contentWindow', { value: peer, configurable: true });
  receive(browser, {}, { type: 'mermaid:ready' });
  assert.equal(posts.length, 0);
  receive(browser, peer, { type: 'mermaid:ready' });
  assert.equal(posts.length, 1);

  const { requestId } = posts[0];

  receive(browser, {}, {
    type: 'mermaid:result',
    requestId,
    svg: safe,
  });
  receive(browser, peer, {
    type: 'mermaid:result',
    requestId: 'old',
    svg: safe,
  });
  receive(browser, peer, {
    type: 'mermaid:result',
    requestId,
    svg: {},
  });
  receive(browser, peer, {
    type: 'mermaid:result',
    requestId,
    svg: 'x'.repeat(2_000_001),
  });
  await Promise.resolve();
  assert.equal(completed, false);
  receive(browser, peer, {
    type: 'mermaid:result',
    requestId,
    svg: safe,
  });
  assert.equal((await pending)?.width, 120);
  assert.equal(Object.hasOwn(posts[0], 'workspace'), false);
  assert.deepEqual(Object.keys(posts[0]).sort(), ['code', 'requestId', 'theme', 'type']);
});

test('RMD-MM-06: очередь, отмена и таймаут не блокируют следующие задания', async (t) => {
  const browser = await installUiBrowser(t);

  browser.happyDOM.settings.disableJavaScriptFileLoading = true;
  browser.happyDOM.settings.disableJavaScriptEvaluation = true;

  const client = createMermaidRenderer({
    document: browser.document,
    rendererUrl: 'https://grigdesk.test/assets/mermaid.js',
    loadRenderer: () => new Promise(() => {}),
    timeoutMs: 100,
  });

  t.after(() => client.dispose());

  const first = client.render('flowchart TD\n A-->B');
  const frame = browser.document.querySelector('iframe');
  const posts = [];
  const peer = { postMessage: (data) => posts.push(data) };

  Object.defineProperty(frame, 'contentWindow', { value: peer, configurable: true });
  receive(browser, peer, { type: 'mermaid:ready' });

  const second = client.render('sequenceDiagram\n A->>B: x');
  const controller = new AbortController();
  const removed = client.render('flowchart TD\n C-->D', { signal: controller.signal });

  controller.abort();
  assert.equal(await removed, null);
  assert.equal(posts.length, 1);
  receive(browser, peer, {
    type: 'mermaid:result',
    requestId: posts[0].requestId,
    error: 'render_failed',
  });
  assert.equal(await first, null);
  assert.equal(posts.length, 2);
  receive(browser, peer, {
    type: 'mermaid:result',
    requestId: posts[1].requestId,
    svg: safe,
  });
  assert.equal((await second)?.height, 80);

  const slow = client.render('flowchart TD\n S-->T');
  const following = client.render('flowchart TD\n T-->U');

  assert.equal(await slow, null);

  const nextFrame = browser.document.querySelector('iframe');
  const nextPosts = [];
  const nextPeer = { postMessage: (data) => nextPosts.push(data) };

  assert.equal(nextFrame === frame, false);
  Object.defineProperty(nextFrame, 'contentWindow', { value: nextPeer, configurable: true });
  receive(browser, peer, {
    type: 'mermaid:result',
    requestId: posts[2].requestId,
    svg: safe,
  });
  receive(browser, nextPeer, { type: 'mermaid:ready' });
  receive(browser, nextPeer, {
    type: 'mermaid:result',
    requestId: nextPosts[0].requestId,
    svg: safe,
  });
  assert.equal((await following)?.width, 120);

  const activeController = new AbortController();
  const cancelled = client.render('flowchart TD\n A-->B', { signal: activeController.signal });

  activeController.abort();
  assert.equal(await cancelled, null);
  receive(browser, nextPeer, {
    type: 'mermaid:result',
    requestId: nextPosts[1].requestId,
    svg: safe,
  });
  assert.equal(browser.document.querySelectorAll('iframe').length, 0);

  const all = [client.render('flowchart TD\n A-->B')];

  for (let index = 0; index < 32; index += 1) {
    all.push(client.render(`flowchart TD\n A-->B${index}`));
  }

  assert.equal(await client.render('flowchart TD\n overflow'), null);
  assert.equal(browser.document.querySelectorAll('iframe').length, 1);
  client.dispose();
  assert.equal((await Promise.all(all)).every((value) => value === null), true);
});

test('RMD-MM-09: asset получает родитель, поздняя загрузка не оживляет отменённый frame', async (t) => {
  const browser = await installUiBrowser(t);
  const sources = [];
  const loads = [];

  browser.happyDOM.settings.disableJavaScriptFileLoading = true;
  browser.happyDOM.settings.disableJavaScriptEvaluation = true;

  const client = createMermaidRenderer({
    document: browser.document,
    rendererUrl: 'https://grigdesk.test/assets/renderer.js',
    loadRenderer: (url) => {
      loads.push(url);

      return new Promise((resolve) => sources.push(resolve));
    },
  });

  t.after(() => client.dispose());

  const controller = new AbortController();
  const first = client.render('flowchart TD\n A-->B', { signal: controller.signal });
  const old = browser.document.querySelector('iframe');

  assert.deepEqual(loads, ['https://grigdesk.test/assets/renderer.js']);
  controller.abort();
  assert.equal(await first, null);

  const second = client.render('flowchart TD\n A-->C');
  const current = browser.document.querySelector('iframe');

  sources[1]('const trusted = "</script><img src=evil>";');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads.length, 2, 'отмена не держит новую загрузку на прежнем promise');
  assert.equal(old.isConnected, false);
  assert.match(current.srcdoc, /script-src 'nonce-[a-f\d]+'/);
  assert.match(current.srcdoc, /\\u003c\/script>/);
  assert.doesNotMatch(current.srcdoc, /<script src=|<img src=evil>/);

  const currentSource = current.srcdoc;

  sources[0]('late cancelled source');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.srcdoc, currentSource);

  client.dispose();
  assert.equal(await second, null);
});

test('RMD-MM-10: parent fetch без cookies ленивый, HTTP-ошибка позволяет повтор', async (t) => {
  const browser = await installUiBrowser(t);
  const originalFetch = globalThis.fetch;
  const calls = [];
  let failed = true;

  browser.happyDOM.settings.disableJavaScriptFileLoading = true;
  browser.happyDOM.settings.disableJavaScriptEvaluation = true;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });

    return new Response(failed ? 'unavailable' : 'void 0;', { status: failed ? 503 : 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = createMermaidRenderer({
    document: browser.document,
    rendererUrl: 'https://grigdesk.test/assets/renderer.js',
  });

  t.after(() => client.dispose());
  assert.equal(calls.length, 0);
  assert.equal(await client.render('flowchart TD\n A-->B'), null);
  assert.equal(Boolean(browser.document.querySelector('iframe')), false);

  failed = false;

  const second = client.render('flowchart TD\n A-->C');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://grigdesk.test/assets/renderer.js');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.signal.aborted, true);
  assert.deepEqual(Object.keys(calls[0].options).sort(), ['credentials', 'signal']);
  assert.match(browser.document.querySelector('iframe').srcdoc, /void 0/);
  client.dispose();
  assert.equal(await second, null);
});

test('RMD-MM-11: зависшая загрузка отменяется таймаутом и не держит следующий asset', async (t) => {
  const browser = await installUiBrowser(t);
  const loads = [];

  browser.happyDOM.settings.disableJavaScriptFileLoading = true;
  browser.happyDOM.settings.disableJavaScriptEvaluation = true;

  const client = createMermaidRenderer({
    document: browser.document,
    rendererUrl: 'https://grigdesk.test/assets/renderer.js',
    timeoutMs: 30,
    loadRenderer: (url, signal) => {
      loads.push({ url, signal });

      return loads.length === 1 ? new Promise(() => {}) : Promise.resolve('void 0;');
    },
  });

  t.after(() => client.dispose());
  assert.equal(await client.render('flowchart TD\n A-->B'), null);

  const second = client.render('flowchart TD\n A-->C');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads.length, 2, 'таймаут не переиспользует зависший promise');
  assert.equal(loads[0].signal.aborted, true);
  assert.match(browser.document.querySelector('iframe').srcdoc, /void 0/);
  client.dispose();
  assert.equal(await second, null);
});

test('RMD-MM-12: nonce работает в HTTP-контексте без crypto.randomUUID', async (t) => {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/chat');
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const cryptoImpl = globalThis.crypto;

  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: (bytes) => cryptoImpl.getRandomValues(bytes) },
  });
  t.after(() => Object.defineProperty(globalThis, 'crypto', originalCrypto));

  const client = createMermaidRenderer({
    document: browser.document,
    rendererUrl: 'http://grigdesk.test/assets/renderer.js',
    loadRenderer: () => new Promise(() => {}),
  });

  t.after(() => client.dispose());

  const pending = client.render('flowchart TD\n A-->B');
  const frame = browser.document.querySelector('iframe');

  assert.equal(Boolean(frame), true);
  assert.match(frame.srcdoc, /script-src 'nonce-[a-f\d]{32}'/);
  client.dispose();
  assert.equal(await pending, null);
});

/**
 * Подменяет только окно песочницы и сообщает готовность настоящему родителю.
 * Сохранённые отправки позволяют отвечать с requestId текущего задания.
 */
function connectFrame(browser) {
  const frame = browser.document.querySelector('iframe');
  const posts = [];
  const peer = { postMessage: (data) => posts.push(data) };

  assert.equal(Boolean(frame), true);
  Object.defineProperty(frame, 'contentWindow', { value: peer, configurable: true });
  receive(browser, peer, { type: 'mermaid:ready' });

  return {
    frame,
    posts,
    peer,
  };
}

/**
 * Кадр отпускается вручную, загрузка библиотеки не влияет на протокольный тест.
 * Каждый новый frame должен запросить отдельное ожидание, в том числе после отмены.
 */
async function paintFixture(t, timeoutMs = 2000) {
  const browser = await installUiBrowser(t);
  const paints = [];

  browser.happyDOM.settings.disableJavaScriptFileLoading = true;
  browser.happyDOM.settings.disableJavaScriptEvaluation = true;

  const client = createMermaidRenderer({
    document: browser.document,
    rendererUrl: 'https://grigdesk.test/assets/mermaid.js',
    loadRenderer: () => new Promise(() => {}),
    waitForPaint: () => new Promise((resolve) => paints.push(resolve)),
    timeoutMs,
  });

  t.after(() => client.dispose());

  return {
    browser,
    paints,
    client,
  };
}

test('RMD-MM-13: frame создаётся только после кадра, отмена и таймаут ждут его', async (t) => {
  await t.test('до кадра frame отсутствует, после кадра принимается схема', async (t) => {
    const { browser, paints, client } = await paintFixture(t);
    const pending = client.render('flowchart TD\n A-->B');

    assert.equal(browser.document.querySelectorAll('iframe').length, 0);
    paints[0]();
    await new Promise((resolve) => setImmediate(resolve));

    const { peer, posts } = connectFrame(browser);

    receive(browser, peer, {
      type: 'mermaid:result',
      requestId: posts[0].requestId,
      svg: safe,
    });
    assert.equal((await pending)?.width, 120);
  });

  await t.test('ожидание 120 мс не расходует таймаут 50 мс', async (t) => {
    const { browser, paints, client } = await paintFixture(t, 50);
    let completed = false;
    const pending = client.render('flowchart TD\n A-->B').then((result) => {
      completed = true;

      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(completed, false);
    assert.equal(browser.document.querySelectorAll('iframe').length, 0);
    paints[0]();
    await new Promise((resolve) => setImmediate(resolve));

    const { peer, posts } = connectFrame(browser);

    receive(browser, peer, {
      type: 'mermaid:result',
      requestId: posts[0].requestId,
      svg: safe,
    });
    assert.equal((await pending)?.height, 80);
  });

  await t.test('отмена до кадра не создаёт frame и не запускает следующее задание', async (t) => {
    const { browser, paints, client } = await paintFixture(t);
    const controller = new AbortController();
    const cancelled = client.render('flowchart TD\n A-->B', { signal: controller.signal });

    controller.abort();
    assert.equal(await cancelled, null);
    paints[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(browser.document.querySelectorAll('iframe').length, 0);

    const following = client.render('flowchart TD\n B-->C');

    assert.equal(paints.length, 2);
    assert.equal(browser.document.querySelectorAll('iframe').length, 0);
    paints[1]();
    await new Promise((resolve) => setImmediate(resolve));

    const { peer, posts } = connectFrame(browser);

    receive(browser, peer, {
      type: 'mermaid:result',
      requestId: posts[0].requestId,
      svg: safe,
    });
    assert.equal((await following)?.width, 120);
  });
});

test('RMD-MM-14: пустой SVG 16×16 пересоздаёт frame один раз', async (t) => {
  const empty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 16 16"></svg>';

  for (const recovered of [true, false]) {
    const scenario = recovered ? 'повтор возвращает нормальную схему' : 'второй пустой ответ даёт null';

    await t.test(scenario, async (t) => {
      const browser = await installUiBrowser(t);

      browser.happyDOM.settings.disableJavaScriptFileLoading = true;
      browser.happyDOM.settings.disableJavaScriptEvaluation = true;

      const client = createMermaidRenderer({
        document: browser.document,
        rendererUrl: 'https://grigdesk.test/assets/mermaid.js',
        loadRenderer: () => new Promise(() => {}),
      });

      t.after(() => client.dispose());

      let created = 0;
      const createElement = browser.document.createElement;

      browser.document.createElement = function (...args) {
        if (args[0] === 'iframe') {
          created += 1;
        }

        return createElement.apply(this, args);
      };
      t.after(() => {
        browser.document.createElement = createElement;
      });

      const pending = client.render('flowchart TD\n A-->B');

      const first = connectFrame(browser);

      receive(browser, first.peer, {
        type: 'mermaid:result',
        requestId: first.posts[0].requestId,
        svg: empty,
      });
      assert.equal(first.frame.isConnected, false);

      const second = connectFrame(browser);

      assert.equal(second.frame === first.frame, false);
      assert.equal(second.posts[0].requestId, first.posts[0].requestId);
      receive(browser, second.peer, {
        type: 'mermaid:result',
        requestId: second.posts[0].requestId,
        svg: recovered ? safe : empty,
      });

      const result = await pending;

      assert.equal(recovered ? result?.width : result, recovered ? 120 : null);
      assert.equal(created, 2);
    });
  }
});
