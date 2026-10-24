import assert from 'node:assert/strict';
import { compileVue, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';

export const ROW = '[data-context="workspace-catalog-row"]';
const controls = {
    composites: ['UiPaneHeader', 'UiField', 'UiFormActions', 'UiDisclosureButton'],
    primitives: ['UiActionLink', 'UiButton', 'UiIconButton', 'UiInput', 'UiSelect',
        'UiSwitch'],
    feedback: ['UiInlineMessage', 'UiLoadingState', 'UiProgress'],
};
const ui = Object.entries(controls).flatMap(([folder, names]) => names.map((name) => {
    const path = webFile(`src/components/${folder}/${name}.vue`);

    return `export { default as ${name} } from '${path}';`;
})).join('\n') + `
export { vTooltip } from './src/services/tooltipDirective.ts';
export const confirmDialog = async (text, options) => {
  const h = globalThis.__sandboxLayoutHarness;
  h.confirmations.push({ text, options });
  return h.confirm ? h.confirm(text, options) : h.confirmed;
};
export const promptDialog = async (options) => {
  const h = globalThis.__sandboxLayoutHarness;
  h.prompts.push(options);
  return h.prompt ? h.prompt(options) : (h.answers.shift() ?? null);
};
`;
const actions = `
const h = () => globalThis.__sandboxLayoutHarness;
export const useSandboxesStore = () => h().store;
export const watchSandboxes = () => { h().calls.push(['watch']); };
export const loadSandboxes = async () => { h().calls.push(['load']); };
export const raiseSandbox = async (profile, task) => {
  h().calls.push(['raise', profile, task]);
  await h().raise?.(profile, task);
};
export const dismantleSandbox = async (task, force) => {
  h().calls.push(['dismantle', task, force]);
};
export const runSandboxAction = async (task, action, args) => {
  h().calls.push(['run', task, action, args]);
  return true;
};
export const loadSandboxJobLog = async (task) => {
  h().calls.push(['log', task]);
  return h().log ? h().log(task) : {
    task, action: 'run', state: 'done', text: 'ИТОГ: проверка успешна', truncated: false,
  };
};
`;
const snapshot = `
export const sandboxPipelineSnapshot = globalThis.__sandboxLayoutHarness.snapshot;
`;
export const ACTION = {
    id: 'check',
    label: 'Проверить стенд',
    description: 'Проверяет страницы и соединение с базой.',
    confirm: 'Будут потрачены лимиты тестового проекта.',
    args: [
        {
            key: 'project',
            label: 'Номер проекта',
            type: 'number',
            required: true,
            hint: 'из песочницы'
        },
        {
            key: 'mode',
            label: 'Режим',
            type: 'string',
            required: false
        },
    ],
};
/**
 * Реестровая запись содержит только синтетические пути и профиль.
 * Переопределения позволяют проверить границы DTO без настоящей инфраструктуры.
 */
export function entry(overrides = {}) {
    return {
        task: '990001',
        profile: 'demo-shop',
        owner: 'manual',
        slot: 0,
        fePort: 5190,
        apiPort: 8090,
        repos: [{
                name: 'backend',
                branch: 'task-990001',
                path: '/workspace/backend/t990001'
            }],
        standAlive: true,
        profileBinding: 'verified',
        removable: true,
        removableReason: null,
        updatedAt: null,
        actions: [],
        ...overrides,
    };
}
/**
 * Общее состояние канала повторяет уже загруженные данные notifyWatch.
 * Пустой loadedAt отличает отсутствие первого ответа от успешного пустого списка.
 */
export function pipelineSnapshot(tasks = [], overrides = {}) {
    return {
        tasks,
        waiting: [],
        stalled: [],
        silent: [],
        running: [],
        observedByTask: Object.fromEntries(tasks.map((task) => [String(task.task), {
                attempt: 'fixture',
                daemon: task.daemonAlive ? 'running' : 'stopped',
                result: task.result || null,
                stall: null,
                gateKnown: true,
                gate: null,
                progress: null,
                stage: null,
            }])),
        loadedAt: 1,
        error: null,
        ...overrides,
    };
}
/**
 * Отложенный ответ принадлежит конкретному действию или журналу.
 * Тест сам разрешает ожидание после замены списка, без таймера и живого сервиса.
 */
export function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });

    return { promise, resolve };
}
/**
 * Монтируется настоящий вид с настоящими UI и реактивными getters стора.
 * Подменены только внешние операции, решения человека и входящий снимок конвейера.
 */
export async function mountSandboxes(t, options = {}) {
    const browser = await installUiBrowser(t, 'http://grigdesk.test/#/sandboxes');
    const { reactive, shallowRef } = await import('../../../web/node_modules/vue/index.mjs');
    const state = reactive({
        profiles: [
            {
                id: 'demo-shop',
                canRaise: true,
                reason: null
            },
            {
                id: 'demo-tools',
                canRaise: true,
                reason: null
            },
        ],
        sandboxes: options.sandboxes ?? [entry()],
        jobs: options.jobs ?? [],
        manualRange: { from: 990000, to: 999999 },
        loading: false,
        loaded: true,
        error: '',
        busyTasks: [],
        ...options.state,
    });
    const store = reactive({
        get profiles() {
            return state.profiles;
        },
        get sandboxes() {
            return state.sandboxes;
        },
        get jobs() {
            return state.jobs;
        },
        get manualRange() {
            return state.manualRange;
        },
        get loaded() {
            return state.loaded;
        },
        get loading() {
            return state.loading;
        },
        get error() {
            return state.error;
        },
        get busyTasks() {
            return state.busyTasks;
        },
        get capableProfiles() {
            return state.profiles.filter((profile) => profile.canRaise);
        },
        get manualSandboxes() {
            return state.sandboxes.filter((item) => item.owner === 'manual');
        },
        get pipelineSandboxes() {
            return state.sandboxes.filter((item) => item.owner === 'pipeline');
        },
        get orphanJobs() {
            return state.jobs.filter((job) => !state.sandboxes.some((item) => item.task === job.task));
        },
        jobOf: (task) => state.jobs.find((job) => job.task === task) || null,
        isBusy: (task) => state.busyTasks.includes(task),
    });
    const harness = {
        state,
        store,
        calls: [],
        confirmations: [],
        prompts: [],
        copied: [],
        answers: [],
        confirmed: true,
        snapshot: shallowRef(options.snapshot ?? pipelineSnapshot()),
    };

    globalThis.__sandboxLayoutHarness = harness;

    const stubs = {
        '../actions/sandboxes': actions,
        '../../actions/sandboxes': actions,
        '../ui': ui,
        '../../ui': ui,
        '../../shared/clipboard.ts': `
export const writeClipboardText = async (text) => {
  globalThis.__sandboxLayoutHarness.copied.push(text);
  return true;
};`,
    };

    for (const prefix of ['../shared/', '../../shared/']) {
        for (const suffix of ['', '.ts']) {
            stubs[`${prefix}sandboxPipelineSnapshot${suffix}`] = snapshot;
        }
    }

    const component = await compileVue(webFile('src/views/SandboxesView.vue'), { stubs });
    const { mount, flushPromises } = await import(
        '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

    t.after(() => {
        wrapper.unmount();
        delete globalThis.__sandboxLayoutHarness;
    });
    await flushPromises();

    return {
        wrapper,
        harness,
        state,
        flushPromises
    };
}
/**
 * Кнопка находится по видимому тексту, поэтому перенос панелей не меняет сценарий.
 * Отсутствие кнопки даёт короткую ошибку без форматирования графа happy-dom.
 */
export function button(wrapper, text) {
    const found = wrapper.findAll('button').find((item) => item.text().replace(/›$/, '').trim() === text);

    assert.ok(Boolean(found), `Есть кнопка «${text}»`);

    return found;
}
/**
 * До реализации карточки видны сразу, после — выбираются через компактную строку.
 * Барьеры действий не должны требовать новую раскладку от исходного кода.
 */
export async function selectStand(wrapper, task) {
    const row = wrapper.findAll(ROW).find((item) => new RegExp(`\\bt${task}\\b`).test(item.text()));

    if (row) {
        await row.trigger('click');
    }
}
/**
 * Строка ищется по номеру задачи, а не индексу или номеру слота.
 * Возврат undefined позволяет вызывающему дать понятное скалярное утверждение.
 */
export function rowOf(wrapper, task) {
    return wrapper.findAll(ROW).find((item) => new RegExp(`\\bt${task}\\b`).test(item.text()));
}
