import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../web/node_modules/vite/dist/node/index.js';
import vue from '../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { chromium } from '../../desktop/node_modules/playwright-core/index.mjs';

import { arbiterDecisionFixture } from '../server/helpers/arbiterDecisionFixture.js';
import { ArbiterConversationStore } from '../../server/src/lib/arbiterConversationStore.ts';
import { ArbiterConversationService } from '../../server/src/lib/arbiterConversationService.ts';
import { ArbiterConversationApply } from '../../server/src/lib/arbiterConversationApply.ts';
import { readArbiterStopContext } from '../../server/src/lib/arbiterStopContext.ts';
import {
  registerArbiterConversationRoutes
} from '../../server/src/modules/factory/arbiterConversationRoutes.ts';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';

const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');

/**
 * Настоящие HTTP, durable service, stage ledger, SSE и Vue работают в изолированных roots.
 * Подменены только модель и запуск оркестратора; пользовательские задачи и чаты не читаются.
 */
export async function arbiterConversationBrowser(t) {
  const ledger = await arbiterDecisionFixture(t);
  const fixtureJournal = path.join(ledger.stateDir, 'logs/t7.stages.log');

  await fs.mkdir(path.dirname(fixtureJournal), { recursive: true });
  await fs.writeFile(fixtureJournal, 'check: waiting-for-test-service\n');

  const artifacts = path.join(process.env.GRIGDESK_ARTIFACTS_DIR
    || path.join(os.homedir(), '.grigdesk/artifacts'), 'arbiter-stop-dialog');

  await fs.mkdir(artifacts, { recursive: true });

  const webRoot = await fs.mkdtemp(path.join(artifacts, 'browser-fixture-'));
  const sockets = new Set();
  const broadcast = (name, value) => {
    for (const response of sockets) {
      response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
    }
  };
  const store = new ArbiterConversationStore(path.join(ledger.root, 'conversations'), (doc) => broadcast(
    'arbiter-conversation', {
    task: '7',
    conversationId: doc.id,
    revision: doc.revision
  },
  ));
  /**
   * Настоящий reader читает только изолированную попытку этого теста.
   * Штатное продолжение маршрута возвращает отсутствие новой остановки.
   */
  const readContext = async () => {
    try {
      return await readArbiterStopContext({ readTrustedAttempt: ledger.trusted }, ledger.config, '7');
    } catch (error) {
      if (error.code === 'not_arbitrable') {
        return null;
      }

      throw error;
    }
  };
  let gotoCalls = 0;
  let resumeCalls = 0;
  let runs = 0;
  let running = false;
  let releaseFirst;
  let failure = '';
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const apply = new ArbiterConversationApply({
    store,
    controlDir: ledger.controlDir,
    readTrusted: ledger.trusted,
    goto: async (_identity, action, reason, expected) => {
      gotoCalls += 1;
      await ledger.rewind(action.targetNode, reason, expected);
    },
    resume: async () => {
      resumeCalls += 1;
      running = resumeCalls > 1;

      return { ok: running, message: 'Стенд недоступен.' };
    },
    running: async () => running
  });
  const result = {
    summary: 'Проверка не завершилась за отведённое время. Пока неизвестно, завис ли отдельный тест '
      + 'или весь набор выполняется долго. Сначала изучим журнал, затем выберем исправление.',
    questions: [{
      id: 'q',
      text: 'Известно, где остановилась проверка?',
      options: [{ id: 'unknown', label: 'Пока неизвестно' }],
      allowCustom: true
    }],
    proposals: [
      {
        id: 'diagnose',
        kind: 'diagnose',
        label: 'Изучить журнал проверки',
        explanation: 'Это читающий разбор.',
        recommended: true,
        expectedResult: 'Узнаем, на каком шаге прервалась проверка.',
        diagnosticInstruction: 'Прочитай журнал проверки.'
      },
      {
        id: 'fix',
        kind: 'apply',
        label: 'Передать исправление этапу подготовки проверок',
        explanation: 'Этап получит указание и сможет исправить подготовку проверки.',
        recommended: false,
        expectedResult: 'Повтор выбранного этапа с пересчётом следующих результатов.',
        action: {
          kind: 'return_to_node',
          targetNode: 'instrument',
          instruction: 'Проверь причину остановки по журналу.',
        }
      },
    ],
    technicalDetails: 'Журнал задачи содержит все визиты; exact источник остановки показан отдельно.',
  };
  const service = new ArbiterConversationService({
    store,
    readContext,
    capabilities: async (context) => ({
      status: 'supported',
      message: '',
      targets: context.targets
    }),
    prepareRun: async () => ({
      input: {}, executor: {
        run: async (input) => {
          runs += 1;
          input.onAssistantMessage({
            assistantMessageId: 'message',
            sourceRevision: 1,
            complete: true,
            text: '<arbiter-message>Читаю сведения о текущей остановке.</arbiter-message>'
          });

          if (runs === 1) {
            await first;
          }

          const mode = failure;

          failure = '';

          if (mode === 'timeout') {
            return new Promise(() => { });
          }
          if (mode === 'invalid') {
            return { reply: '<arbiter-result>{broken' };
          }

          const nextResult = { ...result };

          if (input.message.includes('"intent":"diagnose"')) {
            const log = await fs.readFile(fixtureJournal, 'utf8');

            if (!log.includes('waiting-for-test-service')) {
              throw new Error('Изолированный журнал проверки недоступен.');
            }

            nextResult.summary = 'В журнале задачи видно ожидание ответа тестового сервиса. '
              + 'Причина отсутствия ответа ещё неизвестна. '
              + 'Этап подготовки проверок сможет изучить это ожидание.';
          }

          return { reply: `<arbiter-result>${JSON.stringify(nextResult)}</arbiter-result>` };
        }
      }
    }),
    apply: (doc, operation) => apply.apply(doc, operation),
    resume: (doc, operation, payload) => apply.resume(doc, operation, payload),
    observe: (doc) => apply.observe(doc),
    turnTimeoutMs: 5000,
  });
  const app = Fastify();

  registerArbiterConversationRoutes(app, service, { stateDir: ledger.stateDir });
  app.get('/api/events', (request, reply) => {
    reply.hijack();

    const response = reply.raw;

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write('event: hello\ndata: {"boot":"arbiter-fixture"}\n\n');
    sockets.add(response);
    request.raw.on('close', () => sockets.delete(response));
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

  await fs.writeFile(path.join(webRoot, 'index.html'), '<html><head><meta name="viewport" '
    + 'content="width=device-width,initial-scale=1"></head><body><div id="app"></div>'
    + '<script type="module" src="/entry.js"></script></body></html>');
  await fs.writeFile(path.join(webRoot, 'Harness.vue'), `<template>
<main class="fixture-dialog"><ArbiterConversation :key="epoch" task="7" node="check"
 @current-stop="epoch++" /></main></template>
<script setup>
import {ref} from '/@fs/${repo}/web/node_modules/vue/dist/vue.runtime.esm-bundler.js';
import ArbiterConversation from '/@fs/${repo}/web/src/views/pipeline/ArbiterConversation.vue';
const epoch=ref(0);
</script>
<style>.fixture-dialog{box-sizing:border-box;width:min(100%,1120px);margin:20px auto;padding:20px;
background:var(--surface);border:1px solid var(--line)}
body{margin:0;padding:0}*{box-sizing:border-box}</style>`);
  await fs.writeFile(path.join(webRoot, 'entry.js'), `
import {createApp} from '/@fs/${repo}/web/node_modules/vue/dist/vue.runtime.esm-bundler.js';
import {createPinia} from '/@fs/${repo}/web/node_modules/pinia/dist/pinia.mjs';
import {useArbiterConversationsStore} from '/@fs/${repo}/web/src/stores/arbiterConversations.ts';
import {setUiLocale} from '/@fs/${repo}/web/src/services/locale.ts';
import {setSseEnabled} from '/@fs/${repo}/web/src/composables/useSse.ts';
import '/@fs/${repo}/web/src/styles/index.css';
import Harness from './Harness.vue';
const pinia=createPinia();
const app=createApp(Harness);app.use(pinia);
setUiLocale(new URL(location.href).searchParams.get('lang') || 'ru');
useArbiterConversationsStore(pinia).start('arbiter-browser-fixture');
setSseEnabled(true);
app.mount('#app');
`);

  const vite = await createServer({
    root: webRoot,
    configFile: false,
    envFile: false,
    plugins: [vue()],
    cacheDir: path.join(webRoot, 'cache'),
    logLevel: 'error',
    resolve: {
      dedupe: ['vue', 'pinia'], alias: {
        vue: path.join(repo, 'web/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
        pinia: path.join(repo, 'web/node_modules/pinia/dist/pinia.mjs'),
      }
    },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [repo, webRoot] },
      watch: { ignored: ['**'] },
      proxy: { '/api': `http://127.0.0.1:${address.port}` }
    },
  });

  await vite.listen();

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];

  page.on('pageerror', (error) => errors.push(error.message));

  const url = `http://127.0.0.1:${vite.httpServer.address().port}`;

  t.after(async () => {
    releaseFirst();
    await fs.writeFile(path.join(artifacts, 'browser-last-state.json'), JSON.stringify({
      text: await page.locator('body').innerText().catch(() => ''),
      documents: await store.list('7'),
      errors,
    }, null, 2));
    await context.close();
    await browser.close();
    await service.close();

    for (const socket of sockets) {
      socket.destroy();
    }

    await app.close();
    await vite.close();
    await fs.rm(webRoot, { recursive: true, force: true });
  });

  return {
    ...ledger,
    page,
    browserContext: context,
    url,
    artifacts,
    errors,
    service,
    store,
    releaseFirst,
    broadcast,
    gotoCalls: () => gotoCalls,
    resumeCalls: () => resumeCalls,
    runs: () => runs,
    failNext: (mode) => {
      failure = mode;
    },
    stopAgain: async () => {
      const verdict = Buffer.from(canonicalJson({
        owner: 'tests', findings: [
          {
            id: 'timeout',
            severity: 'blocking',
            summary: 'Новая остановка проверки по времени.'
          },
        ]
      })).toString('base64');

      await ledger.call(
        'attempt_stage_state_commit_v2',
        '7',
        ledger.attempt,
        'check',
        'failed',
        '0',
        verdict
      );
    }
  };
}
