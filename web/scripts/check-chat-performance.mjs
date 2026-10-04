#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpus, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../node_modules/vite/dist/node/index.js';
import vue from '../node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { decodeHistoryStepReuseRequest } from '../../shared/chatHistoryStepReuse.ts';
import { performanceData } from '../../tests/web/fixtures/chat-performance/data.mjs';
import { performanceStubs } from './chatPerformanceStubs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'web');
const fixture = path.join(root, 'tests/web/fixtures/chat-performance');
const artifactName = process.env.CHAT_PERFORMANCE_ARTIFACTS || 'chat-freeze-fix';
const artifacts = path.join(root, '.state/artifacts', artifactName);
const label = process.env.CHAT_PERFORMANCE_LABEL || 'after';
const repeats = Number(process.env.CHAT_PERFORMANCE_REPEATS || 5);
const samples = Number(process.env.CHAT_PERFORMANCE_SAMPLES || 20);
const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const {
  chromium
} = requireServer('playwright-core');
const scenarios = ['reorder', 'waiting', 'progress', 'step', 'block', 'draft', 'duplicate', 'save'];
const selectedScenarios = process.env.CHAT_PERFORMANCE_SCENARIOS?.split(',') || scenarios;
const modes = ['EVENTS', 'INTERACTION', 'BOUNDARIES']
  .filter((mode) => process.env[`CHAT_PERFORMANCE_${mode}_ONLY`]);
const phase = modes[0]?.toLowerCase() || 'all';
const reportPath = path.join(artifacts, `${label}${phase === 'all' ? '' : `-${phase}`}.json`);
const sourceHashes = new Map();

if (!/^[a-z0-9][a-z0-9_-]*$/u.test(label) || !/^[a-z0-9][a-z0-9_-]*$/u.test(artifactName)) {
  throw new Error('Имя прогона и каталога артефактов должно быть одним безопасным сегментом пути.');
}
if (!Number.isSafeInteger(repeats) || repeats < 1 || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error('Число повторов и событий должно быть положительным целым.');
}
if (modes.length > 1 || selectedScenarios.some((kind) => !scenarios.includes(kind))) {
  throw new Error('Выбери один частичный режим и известные сценарии измерения.');
}

function chromeBinary() {
  return [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find((candidate) => candidate && existsSync(candidate));
}

/**
 * Счётчик привязан к единственной точке в исходнике; исчезновение или дублирование
 * этой точки прерывает сборку, чтобы зелёный отчёт не скрывал слепую проверку.
 */
function replaceOnce(source, needle, replacement) {
  const matches = typeof needle === 'string'
    ? source.split(needle).length - 1
    : [...source.matchAll(new RegExp(needle.source, 'gu'))].length;

  assert.equal(matches, 1, `Точка инструментирования: ${needle}`);

  return source.replace(needle, replacement);
}

/**
 * Инструментирование считает вызовы и размер обхода, не подменяя результат функций.
 * Ни одного прототипного кэша или обходного пути обновления здесь нет.
 */
function instrument(source, id) {
  const relative = path.relative(root, id);

  if (id.startsWith(root + path.sep) && !id.includes('/node_modules/') && !id.includes('?')) {
    sourceHashes.set(relative, createHash('sha256').update(source).digest('hex'));
  }

  if (relative === 'web/src/shared/md.ts') {
    let code = source;

    for (const name of ['mdToText', 'mdToHtml', 'lexMarkdown', 'mdTokensToHtml']) {
      code = replaceOnce(code, new RegExp(`(export function ${name}[^]*?\\n)(  )`, 'u'),
        `$1  if (window.__chatPerformanceStats) window.__chatPerformanceStats.${name} += 1;\n$2`);
    }

    return {
      code,
      map: null
    };
  }

  const heavyFunctions = {
    'web/src/shared/markdown/codeHighlight.ts': 'highlightCode',
    'web/src/shared/markdown/mermaidRender.ts': 'renderMermaid',
  };
  const heavyName = heavyFunctions[relative];

  if (heavyName) {
    const entry = new RegExp(`(export (?:async )?function ${heavyName}[^]*?\\{\\n)`, 'u');

    return {
      code: replaceOnce(source, entry,
        `$1  if (window.__chatPerformanceStats) window.__chatPerformanceStats.${heavyName} += 1;\n`),
      map: null
    };
  }
  if (relative === 'web/src/views/chat/chatTimeline.ts') {
    const code = replaceOnce(source, 'function turnRows(turn: TimelineTurn): ChatTimelineRow[] {', `
function turnRows(turn: TimelineTurn): ChatTimelineRow[] {
  if (!turn.live && window.__chatPerformanceStats) {
    window.__chatPerformanceStats.historicalTurns += 1;
    window.__chatPerformanceStats.historicalSteps += turn.steps.length;
  }`);

    return {
      code,
      map: null
    };
  }
  if (relative === 'web/src/views/chat/StepList.vue') {
    return {
      code: replaceOnce(source, 'const rows = computed(() => {', `const rows = computed(() => {
  if (window.__chatPerformanceStats) window.__chatPerformanceStats.stepLists += 1;`),
      map: null
    };
  }
  if (relative === 'web/src/shared/apiClient.ts') {
    const measured = replaceOnce(source, 'opts.body = JSON.stringify(body);', `
    const serializationStart = performance.now();
    opts.body = JSON.stringify(body);
    if (method === 'PUT' && path.startsWith('/api/chat/store/chat')) {
      window.__chatPerformanceStats?.put.push({
        ms: performance.now() - serializationStart,
        chars: opts.body.length,
        sparse: path.endsWith('/step-reuse'),
      });
    }`);

    return {
      code: replaceOnce(measured, "opts.body = new Blob([opts.body], { type: 'application/json' });", `
      opts.body = new Blob([opts.body], { type: 'application/json' });
      const prepared = window.__chatPerformanceStats?.put.at(-1);
      if (prepared) prepared.prepareMs = performance.now() - serializationStart;`),
      map: null
    };
  }

  return null;
}

/**
 * Production-сборка размещается в артефактах и запрещает внешнюю базу API.
 * Подмена служб выполняется до сборки SFC, Markdown и хронология остаются настоящими.
 */
async function buildFixture() {
  const outDir = path.join(artifacts, `dist-${label}`);

  if (label === 'before' && existsSync(outDir)) {
    throw new Error('Исходная сборка уже сохранена: используй CHAT_PERFORMANCE_COMPILED=1.');
  }

  await build({
    root: fixture,
    configFile: false,
    mode: 'production',
    logLevel: 'warn',
    define: {
      'import.meta.env.VITE_BRAIN_URL': '""'
    },
    plugins: [{
      name: 'chat-performance-counters',
      enforce: 'pre',
      load(id) {
        return performanceStubs.get(path.relative(root, id)) ?? null;
      },
      transform: instrument,
    }, vue()],
    resolve: {
      alias: {
        vue: path.join(web, 'node_modules/vue'),
        pinia: path.join(web, 'node_modules/pinia'),
        'vue-router': path.join(web, 'node_modules/vue-router'),
        marked: path.join(web, 'node_modules/marked'),
      }
    },
    build: {
      outDir,
      target: 'esnext',
      emptyOutDir: true,
      minify: !process.env.CHAT_PERFORMANCE_PROFILE,
    },
  });

  const driver = await readFile(fileURLToPath(import.meta.url));

  await writeFile(path.join(outDir, 'performance-build.json'), JSON.stringify({
    sources: Object.fromEntries([...sourceHashes].sort(([left], [right]) => left.localeCompare(right))),
    driver: createHash('sha256').update(driver).digest('hex'),
  }));
}

/**
 * Хэши готовой сборки привязывают замер к реально загруженным файлам, включая старый baseline.
 * Без прежнего manifest источник кэшированной сборки остаётся явно неизвестным.
 */
async function buildIdentity() {
  const directory = path.join(artifacts, `dist-${label}`);
  const hashes = {};

  /**
   * Обход включает только исполняемые assets и HTML, без изменяемых отчётов и manifest.
   * Путь в отчёте относительный; содержимое исходников в артефакт не копируется.
   */
  const visit = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);

      if (entry.isDirectory()) {
        await visit(filename);
      } else if (/\.(html|js|css)$/u.test(entry.name)) {
        const source = await readFile(filename);

        hashes[path.relative(directory, filename)] = createHash('sha256').update(source).digest('hex');
      }
    }
  };

  await visit(directory);

  const manifest = path.join(directory, 'performance-build.json');

  return {
    bundle: hashes,
    sources: existsSync(manifest) ? JSON.parse(await readFile(manifest, 'utf8')) : null,
  };
}

/**
 * Приёмник работает с настоящим файловым хранилищем в отдельном процессе от страницы.
 * Начальный seed создаётся вне замера; полные тела и UTF-8 размеры проверяются на сервере.
 */
async function receiver() {
  const chatsDir = path.join(artifacts, `receiver-${label}`);
  const store = new ChatHistoryStore({
    chatsDir,
    registryProvider: async () => ({
      'fixture-provider': [{
        id: 'fixture-model'
      }]
    }),
  });
  const received = [];
  let state;

  /**
   * Каждый повтор начинает с того же файла истории вне браузерного замера.
   * Только каталоги данного приёмника удаляются между синтетическими сценариями.
   */
  const reset = async (legacy) => {
    await rm(chatsDir, {
      recursive: true,
      force: true
    });
    state = performanceData(legacy);
    received.length = 0;

    for (const chat of [...state.sessions.slice(1), state.sessions[0]]) {
      await store.saveOne(chat);
    }
  };
  const app = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const route = url.pathname;
      let result = {};

      if (request.method === 'GET' && route === '/api/chat/store') {
        result = {
          ...await store.read(),
          activeId: 'fixture-0',
          historyStepReuseProtocol: label === 'before' ? 0 : 1
        };
        received.push({
          method: 'GET',
          route
        });
      } else if (request.method === 'GET' && route.startsWith('/api/chat/store/chat/')) {
        received.push({
          method: 'GET',
          route
        });
        result = {
          chat: await store.readOne(route.split('/').at(-1))
        };
      } else if (request.method === 'PUT' && ['/api/chat/store/chat',
          '/api/chat/store/chat/step-reuse'
        ].includes(route)) {
        const started = performance.now();
        const buffers = [];

        for await (const buffer of request) {
          buffers.push(buffer);
        }

        const bytes = Buffer.concat(buffers);
        const body = JSON.parse(bytes.toString('utf8'));
        const sparse = route.endsWith('/step-reuse');
        const reuseSteps = sparse ? decodeHistoryStepReuseRequest(body.reuseSteps, body.chat
          .messages) : null;

        if (sparse && !reuseSteps) {
          response.writeHead(400, {
            'Content-Type': 'application/json'
          });
          response.end(JSON.stringify({
            error: 'bad_step_reuse'
          }));

          return;
        }

        const record = {
          method: 'PUT',
          route,
          sparse,
          bytes: bytes.length,
          ms: 0,
          status: 200,
          stepBytes: Buffer.byteLength(JSON.stringify(body.chat.messages.map((message) => message
            .steps))),
          historicalBodies: body.chat.messages.slice(0, state.sessions[0].messages.length)
            .filter((message) => Array.isArray(message.steps)).length,
          refs: reuseSteps?.refs.length || 0
        };

        received.push(record);

        try {
          const saved = await store.saveOne(body.chat, body.archived, reuseSteps ? {
            reuseSteps
          } : {});

          record.ms = performance.now() - started;
          result = {
            ...saved,
            ...saved.chat
          };
          delete result.chat;
          delete result.messages;
        } catch (error) {
          record.ms = performance.now() - started;
          record.status = error.statusCode || 500;
          record.error = error.code || error.message;

          throw error;
        }
      } else if (route.startsWith('/api/')) {
        received.push({
          method: request.method,
          route
        });
        result = {
          active: [],
          queued: [],
          waiting: [],
          pending: [],
          items: [],
          entries: []
        };
      } else {
        const target = path.join(artifacts, `dist-${label}`, route === '/' ? 'index.html' : route);

        if (route === '/favicon.ico') {
          response.writeHead(204).end();

          return;
        }

        response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' :
          target.endsWith('.css') ? 'text/css' : 'text/html');
        response.end(await readFile(target));

        return;
      }

      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error.statusCode || 500, {
        'Content-Type': 'application/json'
      });
      response.end(JSON.stringify({
        error: error.code || error.message
      }));
    }
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));

  return {
    app,
    reset,
    store,
    received,
    address: `http://127.0.0.1:${app.address().port}`
  };
}

/**
 * Квантили считаются по всем событиям, а не по средним пяти страниц.
 * Длительности остаются отчётом; assert проверяет только поведение и целостность.
 */
function quantiles(values) {
  const sorted = [...values].sort((left, right) => left - right);

  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

/**
 * Playwright отправляет реальные нажатия во время непрерывной серии SSE.
 * Задержка до подтверждённого переключения включает работу DOM и транспорт автоматизации.
 */
async function measureInteraction(browser, backend, errors) {
  const results = [];

  for (const legacy of [false, true]) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      await backend.reset(legacy);

      const context = await browser.newContext({
        viewport: {
          width: 1280,
          height: 900
        }
      });

      try {
        await context.route('**/*', (route) => route.request().url().startsWith(backend.address + '/') ?
          route.continue() : route.abort());

        const page = await context.newPage();

        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') {
            errors.push(message.text());
          }
        });
        await page.goto(backend.address);
        await page.waitForFunction(() => !!window.__chatPerformance);
        await page.evaluate(() => {
          let index = 1;
          const timer = setInterval(() => {
            window.__chatPerformance.dispatch('progress', index++);

            if (index > 100) {
              clearInterval(timer);
            }
          }, 30);
        });

        const input = [];

        for (let index = 0; index < 20; index += 1) {
          const started = performance.now();

          await page.locator('.cs textarea').press('a');
          input.push(performance.now() - started);
        }

        const started = performance.now();

        await page.getByText('Искусственный разговор 1', {
          exact: true
        }).click();
        await page.waitForFunction(() => window.__chatPerformance.chat.activeId === 'fixture-1');

        results.push({
          legacy,
          input: quantiles(input),
          samples: input,
          switchMs: performance.now() - started
        });
      } finally {
        await context.close();
      }
    }
  }

  return results;
}

/**
 * Отдельные свежие страницы измеряют холодную загрузку, новую ленту и full fallback.
 * Эти затраты не смешиваются с попаданиями в кэш обычной серии SSE.
 */
async function measureBoundaries(browser, backend, errors) {
  const results = [];

  for (const legacy of [false, true]) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      await backend.reset(legacy);

      const context = await browser.newContext({
        viewport: {
          width: 1280,
          height: 900
        }
      });

      try {
        await context.route('**/*', (route) => {
          if (!route.request().url().startsWith(backend.address + '/')) {
            errors.push('Запрещён запрос вне приёмника fixture');

            return route.abort();
          }

          return route.continue();
        });
        await context.addInitScript(() => {
          const started = performance.now();
          const load = {
            started,
            fetchMs: 0,
            bodyMs: 0,
            parseMs: null,
            jsonReadMs: null,
            mountMs: 0,
            paintMs: 0
          };
          const originalFetch = window.fetch;
          const originalParse = JSON.parse;
          let storeBody;

          window.__chatInitialLoad = load;
          JSON.parse = (value, reviver) => {
            const parseStarted = performance.now();
            const result = originalParse(value, reviver);

            if (storeBody && value === storeBody) {
              load.parseMs = performance.now() - parseStarted;
              load.mountStarted = performance.now();
              storeBody = undefined;
            }

            return result;
          };
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);

            if (String(args[0]).endsWith('/api/chat/store')) {
              load.fetchMs = performance.now() - started;

              const originalText = response.text.bind(response);
              const originalJson = response.json.bind(response);

              response.text = async () => {
                const bodyStarted = performance.now();

                storeBody = await originalText();
                load.bodyMs = performance.now() - bodyStarted;

                return storeBody;
              };
              response.json = async () => {
                const jsonStarted = performance.now();
                const result = await originalJson();

                load.jsonReadMs = performance.now() - jsonStarted;
                load.mountStarted = performance.now();

                return result;
              };
            }

            return response;
          };

          const observer = new MutationObserver(() => {
            if (document.querySelector('.cs textarea') && load.mountStarted) {
              load.mountMs = performance.now() - load.mountStarted;
              observer.disconnect();
              requestAnimationFrame(() => requestAnimationFrame(() => {
                load.paintMs = performance.now() - started;
              }));
            }
          });

          observer.observe(document, {
            childList: true,
            subtree: true
          });
        });

        const page = await context.newPage();
        const expectedConsole = [];
        let expectConflict = false;

        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') {
            const conflict = 'Failed to load resource: the server responded with a status of 409 (Conflict)';

            if (expectConflict
              && message.location().url === backend.address + '/api/chat/store/chat/step-reuse'
              && message.text() === conflict) {
              expectedConsole.push(message.text());

              return;
            }

            errors.push(message.text());
          }
        });
        await page.goto(backend.address);
        await page.waitForFunction(() => !!window.__chatPerformance);

        const initial = await page.evaluate(() => window.__chatInitialLoad);

        assert.ok(initial.parseMs > 0 || initial.jsonReadMs > 0, 'Декодирование GET не измерено');
        assert.ok(initial.mountMs > 0 && initial.paintMs > 0, 'Первый монтаж и кадр не измерены');

        backend.received.length = 0;

        const large = await page.evaluate(async () => {
          const {
            chat,
            resetStats
          } = window.__chatPerformance;
          const session = chat.session('fixture-0');
          const steps = Array.from({
            length: 150
          }, (_, index) => ({
            k: 'tool',
            id: `new-${index}`,
            text: `Новая лента ${index}. `.padEnd(1000, 'о'),
            at: Date.now() + index,
          }));

          resetStats();

          const started = performance.now();

          chat._applyPending(session, {
            id: 'large-final',
            runId: 'current-run',
            turnId: 'current-turn',
            assistantMessageId: 'large-answer',
            reply: 'Готова большая лента',
            model: 'fixture-model',
            steps,
          });

          const copyMs = performance.now() - started;

          await chat._writeChat(session.id);

          return {
            copyMs,
            ackMs: performance.now() - started,
            put: structuredClone(window.__chatPerformanceStats.put),
          };
        });
        const savedLarge = await backend.store.readOne('fixture-0');
        const firstNew = savedLarge.messages.find((message) => message.assistantMessageId ===
          'large-answer');

        assert.equal(firstNew.steps.length, 150);
        assert.equal(backend.received.filter((request) => request.method === 'PUT').length, 1);
        assert.ok(backend.received.find((request) => request.method === 'PUT').stepBytes > 150000);

        const largeNetwork = [...backend.received];

        await backend.store.patchExecution('fixture-0', () => ({
          contextTokens: 123
        }));
        backend.received.length = 0;
        expectConflict = true;

        const fallback = await page.evaluate(async () => {
          const {
            chat,
            resetStats
          } = window.__chatPerformance;

          resetStats();
          chat.session('fixture-0').draft = 'После конфликта';

          const started = performance.now();

          await chat._writeChat('fixture-0');

          return {
            ackMs: performance.now() - started,
            put: structuredClone(window.__chatPerformanceStats.put)
          };
        });
        const durable = await backend.store.readOne('fixture-0');
        const original = performanceData(legacy).sessions[0].messages;

        assert.deepEqual(durable.messages.slice(0, original.length), original);
        assert.deepEqual(durable.messages.find((message) => message.assistantMessageId === 'large-answer'),
          firstNew);

        const fallbackNetwork = [...backend.received];

        assert.deepEqual(fallbackNetwork.map((request) => request.status),
          label === 'before' ? [200] : [409, 200]);

        if (label !== 'before') {
          assert.equal(fallbackNetwork[0].error, 'chat_steps_changed');
          assert.equal(expectedConsole.length, 1);
        }

        results.push({
          legacy,
          initial,
          large,
          largeNetwork,
          fallback,
          fallbackNetwork,
          expectedConsole,
        });
      } finally {
        await context.close();
      }
    }
  }

  return results;
}

/**
 * Условия относятся к работе кэшей и форме запроса, а не к скорости конкретной машины.
 * Устойчивое событие не разбирает старый Markdown, ленты и подтверждённые тела.
 */
function checkCachedBehavior(result) {
  const historyReads = result.network.filter((item) => item.method === 'GET'
    && (item.route === '/api/chat/store' || item.route.startsWith('/api/chat/store/chat/')));

  assert.equal(historyReads.length, 0, 'Устойчивая запись перечитывает всю историю');

  for (const sample of result.measurements) {
    assert.equal(sample.stats.historicalTurns, 0, `${result.kind}: развёрнута старая лента`);
    assert.equal(sample.stats.historicalSteps, 0);

    if (['reorder', 'waiting', 'progress', 'step', 'duplicate'].includes(result.kind)) {
      assert.equal(sample.stats.mdToText, 0, `${result.kind}: разобрано неизменённое превью`);

      for (const name of ['mdToHtml', 'lexMarkdown', 'mdTokensToHtml', 'highlightCode', 'renderMermaid']) {
        assert.equal(sample.stats[name], 0, `${result.kind}: вызван ${name}`);
      }
    }
  }

  for (const request of result.network.filter((item) => item.method === 'PUT')) {
    assert.equal(request.sparse, true);
    assert.equal(request.historicalBodies, 0);
    assert.equal(request.refs, 50);
  }
}

/**
 * Диагностический режим сохраняет стеки CPU и trace в артефактах на синтетических данных.
 * Он отделён от основной серии: profiler меняет стоимость задачи и не даёт сравнимых таймингов.
 */
async function profileTasks(browser, backend) {
  for (const [legacy, kind] of [[false, 'block'], [true, 'block']]) {
    await backend.reset(legacy);

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    try {
      await context.route('**/*', (route) => route.request().url().startsWith(backend.address + '/')
        ? route.continue() : route.abort());

      const page = await context.newPage();

      await page.goto(backend.address);
      await page.waitForFunction(() => !!window.__chatPerformance);
      await page.evaluate((type) => window.__chatPerformance.event(type, 0), kind);

      const session = await context.newCDPSession(page);
      const trace = [];

      session.on('Tracing.dataCollected', ({ value }) => trace.push(...value));
      await session.send('Profiler.enable');
      await session.send('Profiler.start');
      await session.send('Tracing.start', {
        categories: 'devtools.timeline,v8',
        transferMode: 'ReportEvents',
      });

      const measurements = [];

      for (let index = 1; index <= 20; index += 1) {
        measurements.push(await page.evaluate(([type, sequence]) =>
          window.__chatPerformance.event(type, sequence), [kind, index]));
      }

      const { profile } = await session.send('Profiler.stop');
      const finished = new Promise((resolve) => session.once('Tracing.tracingComplete', resolve));

      await session.send('Tracing.end');
      await finished;

      const history = legacy ? 'legacy' : 'modern';

      await writeFile(path.join(artifacts, `profile-${history}-${kind}.json`), JSON.stringify({
        measurements,
        profile,
        trace,
      }));
    } finally {
      await context.close();
    }
  }
}

/**
 * Каждый сценарий получает свежий context и одинаковую базу после прогрева.
 * Чужие адреса запрещены даже при неожиданном импорте новой внешней службы.
 */
async function main() {
  await mkdir(artifacts, {
    recursive: true
  });

  if (!process.env.CHAT_PERFORMANCE_COMPILED) {
    await buildFixture();
  }

  const backend = await receiver();
  let browser;
  const results = [];
  const errors = [];
  let positiveControl;
  const metadata = {
    node: process.version,
    cpu: cpus()[0]?.model,
    load: loadavg(),
    repeats,
    samples,
    cpuThrottling: 'отключён',
    phase,
    scenarios: selectedScenarios,
    build: await buildIdentity(),
  };

  try {
    browser = await chromium.launch({
      executablePath: chromeBinary(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    metadata.browser = browser.version();

    if (label !== 'before') {
      await backend.reset(false);

      const controlPage = await browser.newPage();

      try {
        controlPage.on('pageerror', (error) => errors.push(error.message));
        await controlPage.goto(backend.address);
        await controlPage.waitForFunction(() => !!window.__chatPerformance);
        positiveControl = await controlPage.evaluate(() => window.__chatPerformance.control());
      } finally {
        await controlPage.close();
      }

      for (const name of ['mdToText', 'mdToHtml', 'lexMarkdown', 'mdTokensToHtml',
        'highlightCode', 'renderMermaid']) {
        assert.ok(positiveControl.initial[name] + positiveControl.closed[name] > 0,
          `Positive control не видит ${name}`);
      }

      assert.equal(positiveControl.closed.renderMermaid, 1);
      // Закрытая Mermaid временно показывает исходник: его неизвестный язык даёт null,
      // а два уже готовых блока кода не вызывают подсветчик повторно.
      assert.equal(positiveControl.closed.highlightCode, 1);
      assert.equal(positiveControl.tail.highlightCode, 0);
      assert.equal(positiveControl.tail.renderMermaid, 0);
      assert.equal(positiveControl.kept, true);
      assert.equal(positiveControl.expanded, true);
      assert.equal(positiveControl.showingCode, true);
    }

    if (process.env.CHAT_PERFORMANCE_PROFILE) {
      await profileTasks(browser, backend);

      return;
    }

    for (const legacy of [false, true]) {
      for (const kind of ['all', 'events'].includes(phase) ? selectedScenarios : []) {
        const measurements = [];
        const network = [];

        for (let repeat = 0; repeat < repeats; repeat += 1) {
          await backend.reset(legacy);

          const context = await browser.newContext({
            viewport: {
              width: 1280,
              height: 900
            }
          });

          try {
            await context.route('**/*', (route) => {
              if (!route.request().url().startsWith(backend.address + '/')) {
                errors.push('Запрещён запрос вне приёмника fixture');

                return route.abort();
              }

              return route.continue();
            });

            const page = await context.newPage();

            page.on('pageerror', (error) => errors.push(error.message));
            page.on('console', (message) => {
              if (message.type() === 'error') {
                errors.push(message.text());
              }
            });
            await page.goto(backend.address);
            await page.waitForFunction(() => !!window.__chatPerformance);
            await page.evaluate((type) => window.__chatPerformance.event(type, 0), kind);
            backend.received.length = 0;

            for (let index = 1; index <= samples; index += 1) {
              measurements.push(await page.evaluate(([type, sequence]) =>
                window.__chatPerformance.event(type, sequence), [kind, index]));
            }

            // Полная сверка вне потока страницы обнаруживает повреждение любого тела шага.
            const saved = await backend.store.readOne('fixture-0');
            const seeded = performanceData(legacy).sessions[0].messages;

            assert.deepEqual(saved.messages.slice(0, seeded.length), seeded);
            network.push(...backend.received);
          } finally {
            await context.close();
          }
        }

        const result = {
          legacy,
          kind,
          event: quantiles(measurements.map((sample) => sample.eventMs)),
          frame: quantiles(measurements.map((sample) => sample.frameMs)),
          ack: quantiles(measurements.map((sample) => sample.ackMs)),
          measurements,
          network,
        };

        if (label !== 'before') {
          checkCachedBehavior(result);
        }

        results.push(result);
        await writeFile(reportPath, JSON.stringify({
          metadata,
          errors,
          results,
          complete: false,
        }));
        process.stdout.write(JSON.stringify({
          legacy,
          kind,
          event: result.event,
          errors: errors.length
        }) + '\n');
      }
    }

    const interaction = ['all', 'interaction'].includes(phase)
      ? await measureInteraction(browser, backend, errors)
      : undefined;
    const boundaries = ['all', 'boundaries'].includes(phase)
      ? await measureBoundaries(browser, backend, errors)
      : undefined;

    await writeFile(reportPath, JSON.stringify({
      metadata,
      results,
      ...(interaction ? {
        interaction
      } : {}),
      boundaries,
      positiveControl,
      errors,
      complete: errors.length === 0,
    }));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => backend.app.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
