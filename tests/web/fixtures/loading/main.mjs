import { prepareStore } from './extraCases.mjs';
import { createApp, h, nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import * as ui from '../../../../web/src/ui.ts';
import ChatsView from '../../../../web/src/views/ChatsView.vue';
import ChatSession from '../../../../web/src/views/chat/ChatSession.vue';
import { useChatStore, counts } from './ports.mjs';
import { propCases, portCases } from './cases.mjs';
import '../../../../web/src/styles/index.css';

const pinia = createPinia();

setActivePinia(pinia);

const chat = useChatStore();
const mode = new URL(location.href).searchParams.get('mode') || 'chat';
const state = reactive({ transformed: false });
const spec = [...propCases, ...portCases].find((item) => mode === item.id);
const props = reactive(spec?.pending || {});
const store = reactive(spec?.state ? structuredClone(spec.state) : {});

prepareStore(store);

// Уборка использует настоящий DockerPanel с его container queries и внутренними отступами.
// Порт предоставляет только состояние демона; хост и вкладки остаются продуктовыми.
if (mode === 'docker-usage') {
    Object.assign(store, {
        loading: false,
        error: null,
        health: {
            available: true,
            version: 'fixture'
        },
        counts: {
            running: 0,
            containers: 0,
            images: 0
        },
        projects: [],
        containers: [],
        images: [],
        stats: {},
        async load() {},
        async loadUsage() {},
        watchStats() {},
        stopStats() {},
    });
}

store.isBusy = () => false;
store.search = () => {};
store.loadModels = () => {};
globalThis.__loadingSurface = { store };

const loaders = {
    'inbox': () => import('../../../../web/src/views/InboxView.vue'),
    'github': () => import('../../../../web/src/views/GitHubView.vue'),
    'telegram': () => import('../../../../web/src/views/TelegramView.vue'),
    'settings-setup': () => import('../../../../web/src/views/settings/pages/PluginSetupPanel.vue'),
    'diff': () => import('../../../../web/src/views/diff/DiffPanel.vue'),
    'routes-policy': () => import('../../../../web/src/views/routes/RouteNodeInspector.vue'),
    'shelf': () => import('../../../../web/src/views/shelf/TaskShelfPanel.vue'),
    'sandboxes': () => import('../../../../web/src/views/SandboxesView.vue'),
    'showcase-source': () => import('../../../../web/src/views/showcase/ShowcaseSourcePanel.vue'),
    'settings-devices': () => import('../../../../web/src/views/settings/DevicesPanel.vue'),
    'projects-list': () => import('../../../../web/src/views/projects/ProjectList.vue'),
    'showcase-picker': () => import('../../../../web/src/views/showcase/ShowcaseTargetPicker.vue'),
    'settings-mcp': () => import('../../../../web/src/views/settings/ProviderMcpStatus.vue'),
    'document-file': () => import('../../../../web/src/features/documents/DocumentPanel.vue'),
    'pipeline-deferred': () => import('../../../../web/src/views/pipeline/DeferredFindings.vue'),
    'docker-containers': () => import('../../../../web/src/views/docker/DockerContainers.vue'),
    'docker-usage': () => import('../../../../web/src/views/docker/DockerPanel.vue'),
    'studio3d-library': () => import('../../../../web/src/views/studio3d/LibraryPanel.vue'),
};
const Surface = spec ? (await loaders[spec.id]()).default : null;
const Gallery = mode === 'gallery'
    ? (await import('../../../../web/dev/ui-gallery/UiGallery.vue')).default
    : null;

/**
 * Композиция упражняет публичный набор, не подменяя продуктовые кирпичики.
 * На старом коде отсутствие экспорта видно assertion-у в браузере.
 */
function kit() {
    if (!ui.UiSkeleton) {
        return h('div', { 'data-kit-unavailable': true });
    }

    return h(ui.UiLoadingState, { description: 'Синтетическое пояснение' }, {
        default: () => h(
            'section',
            { style: state.transformed ? 'transform:translateZ(0)' : '' },
            ['line', 'block', 'circle'].map((shape) => h(ui.UiSkeleton, { shape }))
        ),
    });
}

const app = createApp({
    /**
     * Переключает только хост проверки между настоящими продуктовыми компонентами.
     * Геометрия шапки, списка и ввода принадлежит импортированным SFC.
     */
    render() {
        if (Surface) {
            return h(Surface, props);
        }

        if (Gallery) {
            return h(Gallery);
        }

        if (mode === 'work') {
            return h('main', [
                h(ui.UiSpinner, { label: 'Выполняется операция' }),
                h(ui.UiProgress, {
                    label: 'Передача модели',
                    value: 3,
                    max: 7
                }),
            ]);
        }
        if (mode === 'kit') {
            return kit();
        }
        if (mode === 'composer') {
            return h(ChatSession, { sid: 'fixture-chat' });
        }

        return h(ChatsView);
    },
});

app.use(pinia);
app.mount('#app');
Object.assign(window, {
    loadingFixture: {
        chat,
        counts,
        state,
        /**
         * Подтверждает props или store того же экрана, не меняя viewport и хост.
         * API-ответы отдельно разрешает управляющая сторона Playwright.
         */
        async ready() {
            if (spec?.state) {
                Object.assign(store, spec.readyState);
            } else if (spec) {
                Object.assign(props, spec.ready);
            }

            chat.loaded = true;
            chat.loading = false;
            await nextTick();
        },
    },
});
