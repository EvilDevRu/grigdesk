import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// На сервере NODE_ENV иногда наследуется как production. Runtime DOM и Test Utils должны
// загрузиться после happy-dom и в тестовом режиме, иначе Vue зафиксирует document=null.
process.env.NODE_ENV = 'test';

const REVIEW_VIEW_PATH = fileURLToPath(new URL('../../web/src/views/ReviewsView.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;
const REVIEW_CHIP_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/review-chip.js', import.meta.url),
)).href;

function buttonByText(wrapper, text) {
  return wrapper.findAll('button').find((button) => button.text().includes(text));
}

/**
 * Node test не имеет Vite loader для .vue. Компилируем настоящий SFC тем же
 * @vue/compiler-sfc, а внешние границы (store, topbar и confirm) подменяем контрактными
 * адаптерами. В тест попадают реальный setup и реальный template ReviewsView.
 */
async function compileReviewsView() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(REVIEW_VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: REVIEW_VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: 'data-v-reviews-test',
    inlineTemplate: true,
  }).content;

  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replaceAll("from 'pinia'", `from "${PINIA_URL}"`)
    .replace(
      "import { useRoute } from 'vue-router';",
      'const useRoute = () => ({ query: {} });',
    )
    .replace(
      "import TopbarActions from '../shared/layout/TopbarActions.vue';",
      'const TopbarActions = { name: "TopbarActions", setup(_, { slots }) { return () => slots.default?.(); } };',
    )
    .replace(
      "import { confirmDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = async () => true;',
    )
    .replace(
      "from '../shared/review-chip.js'",
      `from "${REVIEW_CHIP_URL}"`,
    )
    .replace(
      "import { useReviewsStore } from '../stores/reviews.js';",
      'const useReviewsStore = globalThis.__useReviewsTestStore;',
    );

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return (await import(moduleUrl)).default;
}

test('UI-08/UI-SEC-01: ReviewsView показывает исходник и перевод, но не исполняет их HTML', async (t) => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/reviews' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);

  const initialPull = {
    id: 'github:pr-7',
    projectId: 'arsenkin',
    repoKey: 'frontend',
    repoSlug: 'team/frontend',
    number: 7,
    title: 'Проверить безопасный вывод',
    url: 'https://github.test/team/frontend/pull/7',
    author: '<img src=x onerror=alert(1)>',
    headRef: 'feature/review',
    headSha: '1234567890abcdef',
    updatedAt: '2026-07-29T12:00:00.000Z',
    state: 'open',
    attention: { failed: true, unread: true },
    canRun: true,
    run: null,
    remarks: [{
      id: 'remark-1',
      kind: 'inline',
      author: '<script>alert(1)</script>',
      path: 'src/form.js',
      line: 17,
      url: 'https://github.test/team/frontend/pull/7#discussion',
      body: [
        'Полный **исходный комментарий**.',
        '',
        '<img src=x onerror="alert(1)">',
        '',
        '[опасная ссылка](javascript:alert(1))',
      ].join('\n'),
      resolved: false,
      outdated: false,
      analysisStatus: 'failed',
      analysis: { decision: 'fix', summary: 'Проверка пропущена' },
      translation: {
        request: 'Добавить проверку значения',
        recommendation: 'Стоит исправить',
        why: '<script>alert(1)</script> Иначе форма примет пустое значение.',
        change: 'Появится понятная ошибка',
        risks: ['Изменится текст сообщения'],
        decisionNeeded: 'Подтвердить текст ошибки',
      },
      scopeAction: null,
    }],
  };

  const scopeCalls = [];
  const publishCalls = [];
  const abandonCalls = [];
  const useReviewsTestStore = defineStore('reviews-component-test', {
    state: () => ({
      pulls: [structuredClone(initialPull)],
      repositories: [{
        projectId: 'arsenkin',
        repoKey: 'frontend',
        repoSlug: 'team/frontend',
        canFix: false,
        configurationError: {
          code: 'REVIEW_EXECUTOR_UNAVAILABLE',
          message: 'Изолированный Factory executor ещё не подключён',
        },
      }],
      loading: false,
      syncing: false,
      error: null,
      loadedAt: Date.parse('2026-07-29T12:00:00.000Z'),
      busy: {},
    }),
    getters: {
      projects: () => [{ id: 'arsenkin', label: 'arsenkin' }],
      isBusy: (state) => (key) => !!state.busy[key],
    },
    actions: {
      async load() {},
      async sync() {},
      async markRead() {},
      async analyze() {},
      async run() {},
      async accept() {},
      async abandon(runId) {
        abandonCalls.push(runId);
      },
      async publish(runId, options) {
        publishCalls.push({ runId, options: structuredClone(options) });
      },
      async setScope(pullId, items) {
        scopeCalls.push({ pullId, items: structuredClone(items) });
        this.pulls = this.pulls.map((pull) => pull.id !== pullId ? pull : ({
          ...pull,
          remarks: pull.remarks.map((remark) => ({
            ...remark,
            scopeAction: items.find((item) => item.remarkId === remark.id) || null,
          })),
        }));
      },
    },
  });
  globalThis.__useReviewsTestStore = useReviewsTestStore;
  t.after(() => {
    delete globalThis.__useReviewsTestStore;
    browser.close();
  });

  const ReviewsView = await compileReviewsView();
  const wrapper = mount(ReviewsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: {
      plugins: [createPinia()],
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        Teleport: true,
      },
    },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  assert.match(wrapper.text(), /Полный исходный комментарий/);
  assert.match(wrapper.text(), /Что просит ревьюер/);
  assert.match(wrapper.text(), /Стоит ли делать/);
  assert.match(wrapper.text(), /Почему/);
  assert.match(wrapper.text(), /Что изменится/);
  assert.match(wrapper.text(), /Риски/);
  assert.match(wrapper.text(), /Что решить/);
  assert.match(wrapper.text(), /Повторить анализ/);
  assert.match(wrapper.text(), /Сейчас доступны просмотр и анализ PR/);
  assert.match(wrapper.text(), /Изолированный Factory executor ещё не подключён/);
  assert.equal(wrapper.element.querySelector('script'), null);
  assert.equal(wrapper.element.querySelector('[onerror]'), null);
  assert.equal(wrapper.element.querySelector('a[href^="javascript:"]'), null);

  const componentStore = useReviewsTestStore();
  componentStore.pulls[0].remarks[0].analysisStatus = 'manual_required';
  componentStore.pulls[0].remarks[0].translation = null;
  componentStore.pulls[0].remarks[0].autoAnalysis = {
    reason: 'untrusted_author',
    message: 'Внешний автор: анализ запускается только вручную',
  };
  await flushPromises();
  assert.match(wrapper.text(), /Нужен ручной запуск/);
  assert.match(wrapper.text(), /Внешний автор/);
  assert.ok(buttonByText(wrapper, 'Запустить анализ'));

  componentStore.pulls[0].remarks[0].resolved = true;
  componentStore.pulls[0].remarks[0].analysisStatus = 'resolved';
  await flushPromises();
  assert.match(wrapper.text(), /Обсуждение уже закрыто — новый анализ не запускается/);
  assert.equal(buttonByText(wrapper, 'Запустить анализ'), undefined);
  assert.equal(buttonByText(wrapper, 'Повторить анализ'), undefined);

  componentStore.pulls[0].remarks[0].resolved = false;
  componentStore.pulls[0].remarks[0].analysisStatus = 'manual_required';
  await flushPromises();

  const fix = buttonByText(wrapper, 'Исправить');
  const launch = buttonByText(wrapper, 'Запустить исправление');
  assert.ok(fix);
  assert.ok(launch);
  assert.equal(launch.attributes('disabled'), '');

  await fix.trigger('click');
  await flushPromises();
  assert.match(wrapper.text(), /Как понять, что исправление готово/);
  assert.match(wrapper.text(), /Какие относительные файлы агенту разрешено менять/);
  assert.equal(
    wrapper.find('[data-scope-field="allowed-paths"]').element.value,
    'src/form.js',
  );
  assert.equal(launch.attributes('disabled'), '');

  const save = buttonByText(wrapper, 'Сохранить выбор');
  assert.equal(save.attributes('disabled'), '');
  const acceptance = wrapper.find('[data-scope-field="acceptance"]');
  await acceptance.setValue('Тест формы подтверждает, что пустое значение не сохраняется');
  await flushPromises();
  const allowedPaths = wrapper.find('[data-scope-field="allowed-paths"]');
  await allowedPaths.setValue('');
  await flushPromises();
  assert.equal(save.attributes('disabled'), '');
  await allowedPaths.setValue('/etc/passwd');
  await flushPromises();
  assert.equal(save.attributes('disabled'), '');
  await allowedPaths.setValue('src/form.js\ntests/form.test.js');
  await flushPromises();
  assert.equal(save.attributes('disabled'), undefined);
  await save.trigger('click');
  await flushPromises();

  assert.deepEqual(scopeCalls, [{
    pullId: 'github:pr-7',
    items: [{
      remarkId: 'remark-1',
      action: 'fix',
      acceptance: 'Тест формы подтверждает, что пустое значение не сохраняется',
      allowedPaths: ['src/form.js', 'tests/form.test.js'],
    }],
  }]);
  assert.equal(buttonByText(wrapper, 'Запустить исправление').attributes('disabled'), undefined);

  const store = useReviewsTestStore();
  store.pulls[0].runBlockedReason = 'Сначала настрой обязательные VERIFY-команды проекта.';
  store.pulls[0].run = {
    id: 'rr-current',
    state: 'ready',
    rawState: 'verified',
    canAccept: true,
    updatedAt: '2026-07-29T12:30:00.000Z',
    candidate: {
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      diff: {
        stat: '1 file changed',
        files: [{ status: 'M', path: 'src/form.js' }],
        patch: '<script data-candidate>alert(2)</script>\\n+return safe;',
        patchTruncated: false,
      },
      buildEvidence: {
        allowedPaths: ['src/form.js'],
        summary: '<img data-build src=x onerror=alert(3)>',
      },
    },
    verification: {
      report: {
        passed: true,
        candidateTreeDigest: 'digest-current',
        commands: [{
          id: 'project-1',
          label: 'npm test',
          required: true,
          effectiveOk: true,
          compareBaseline: true,
          exitCode: 0,
          stdout: '<img data-command src=x onerror=alert(4)>',
          baseline: { available: true, exitCode: 1, stderr: 'old failure' },
          delta: {
            requested: true,
            classification: 'resolved',
            candidateOk: true,
            baselineOk: false,
          },
        }],
        criteria: [{
          id: 'criterion-1',
          status: 'passed',
          acceptanceCriterion: 'Форма не сохраняет пустое значение',
          reason: 'Проверка прошла',
          commandIds: ['project-1'],
          diffArtifactIds: ['diff-1'],
        }],
        artifacts: [{
          id: 'diff-1',
          kind: 'git-diff-file',
          path: '<img data-artifact src=x onerror=alert(5)>',
        }],
      },
    },
  };
  store.pulls[0].history = [{
    id: 'rr-previous',
    state: 'failed',
    rawState: 'verification_failed',
    updatedAt: '2026-07-28T12:00:00.000Z',
    candidate: {
      commit: 'd'.repeat(40),
      tree: 'e'.repeat(40),
      diff: {
        files: [{ status: 'M', path: 'src/old.js' }],
        patch: '+old candidate',
      },
    },
  }];
  await flushPromises();

  assert.match(wrapper.text(), /Точный candidate для приёмки/);
  assert.match(wrapper.text(), /digest-current/);
  assert.match(wrapper.text(), /Команды и сравнение с baseline/);
  assert.match(wrapper.text(), /ошибка baseline исправлена/);
  assert.match(wrapper.text(), /Форма не сохраняет пустое значение/);
  assert.match(wrapper.text(), /Метаданные доказательств/);
  assert.match(wrapper.text(), /История прошлых запусков/);
  assert.match(wrapper.text(), /Сначала настрой обязательные VERIFY-команды проекта/);
  assert.equal(buttonByText(wrapper, 'Принять результат').attributes('disabled'), undefined);
  const abandon = buttonByText(wrapper, 'Отказаться от результата');
  assert.ok(abandon);
  await abandon.trigger('click');
  await flushPromises();
  assert.deepEqual(abandonCalls, ['rr-current']);
  assert.equal(buttonByText(wrapper, 'Исправить').attributes('disabled'), '');
  assert.equal(buttonByText(wrapper, 'Сохранить выбор').attributes('disabled'), '');
  assert.equal(wrapper.element.querySelector('[data-candidate]'), null);
  assert.equal(wrapper.element.querySelector('[data-build]'), null);
  assert.equal(wrapper.element.querySelector('[data-command]'), null);
  assert.equal(wrapper.element.querySelector('[data-artifact]'), null);

  store.pulls[0].run.state = 'failed';
  store.pulls[0].run.rawState = 'publication_unknown';
  store.pulls[0].run.canAccept = false;
  store.pulls[0].run.canReconcile = true;
  await flushPromises();

  const reconcile = buttonByText(wrapper, 'Сверить');
  const retryPush = buttonByText(wrapper, 'Повторить push');
  assert.ok(reconcile);
  assert.ok(retryPush);
  await reconcile.trigger('click');
  await retryPush.trigger('click');
  await flushPromises();
  assert.deepEqual(publishCalls, [
    { runId: 'rr-current', options: undefined },
    { runId: 'rr-current', options: { retryUnknown: true } },
  ]);

  store.pulls[0].run.rawState = 'blocked';
  store.pulls[0].run.canReconcile = false;
  await flushPromises();
  assert.ok(buttonByText(wrapper, 'Удалить рабочую среду'));
});
