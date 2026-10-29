import { extraProps, extraPorts } from './extraCases.mjs';
import { modelDto } from '../../helpers/studio3d-fixtures.js';

export const documentDto = {
    ref: { source: 'fixture', path: 'readme.txt' },
    name: 'readme.txt',
    format: 'text',
    source: { id: 'fixture', label: 'Синтетический источник' },
    displayPath: 'readme.txt',
    content: 'Первая строка\nВторая строка',
    size: 50,
    modifiedAt: '2026-01-01T00:00:00Z',
};
export const usageDto = {
    source: 'daemon',
    computedAt: '2026-01-01T00:00:00Z',
    cached: false,
    containers: {
        total: 2,
        active: 1,
        stopped: 1,
        size: 100,
        reclaimable: 50
    },
    images: {
        total: 2,
        active: 1,
        unused: 1,
        size: 200,
        reclaimable: 100,
        dangling: { count: 1, size: 100 }
    },
    volumes: {
        total: 2,
        active: 1,
        unused: 1,
        size: 100,
        reclaimable: 50
    },
    networks: { total: 2, unused: 1 },
    buildCache: {
        total: 2,
        size: 100,
        reclaimable: 50
    },
};
export const propCases = [
    ...extraProps,
    {
        id: 'projects-list',
        file: 'src/views/projects/ProjectList.vue',
        pending: {
            items: [],
            loading: true,
            error: ''
        },
        ready: {
            loading: false,
            items: [
                {
                    id: 'fixture',
                title: 'Синтетический проект',
                repos: [],
                tags: [],
                warnings: []
                }
            ],
        },
        empty: { loading: false, items: [] },
        readySelector: '[data-role="project-row"]',
        failure: { error: 'Синтетический отказ', loading: true },
        retryText: 'Повторить',
        retryEvent: 'retry',
    },
    {
        id: 'showcase-picker',
        file: 'src/views/showcase/ShowcaseTargetPicker.vue',
        pending: {
            targets: [],
            projects: [],
            busy: false,
            loaded: false,
            loading: true,
            error: ''
        },
        ready: { loaded: true, loading: false },
        empty: { loaded: true, loading: false },
        readySelector: '.picker__state',
        failure: {
            loading: false,
            loaded: false,
            error: 'Синтетический отказ'
        },
    },
    {
        id: 'settings-mcp',
        file: 'src/views/settings/ProviderMcpStatus.vue',
        pending: {
            providerId: 'fixture',
            providerName: 'Исполнитель',
            status: null
        },
        ready: { status: { loading: false, servers: [
            {
                        name: 'Синтетический MCP',
            scope: 'user',
            state: 'ok'
                    }
        ] } },
        empty: { status: { loading: false, servers: [] } },
        readySelector: '.mcprow',
        failure: { status: {
                loading: true,
            state: 'error',
            error: 'Синтетический отказ'
            } },
        retryText: 'Обновляется…',
    },
];
export const portCases = [
    ...extraPorts,
    {
        id: 'document-file',
        file: 'src/features/documents/DocumentPanel.vue',
        pending: { source: 'fixture', path: 'readme.txt' },
        endpoint: /^\/api\/documents\/file\?source=fixture&path=readme.txt$/,
        response: documentDto,
        readySelector: '.document-body',
        retryText: 'Повторить',
    },
    {
        id: 'pipeline-deferred',
        file: 'src/views/pipeline/DeferredFindings.vue',
        pending: {
            task: 42,
            profile: 'fixture',
            attempt: 'attempt-fixture'
        },
        endpoint: /^\/api\/tasks\/42\/findings\?profile=fixture&attempt=attempt-fixture$/,
        response: {
            taskId: '42',
            profile: 'fixture',
            attemptId: 'attempt-fixture',
            findings: { deferred: [{ id: 'fixture-finding', summary: 'Синтетическое замечание' }] },
        },
        emptyResponse: {
            taskId: '42',
            profile: 'fixture',
            attemptId: 'attempt-fixture',
            findings: { deferred: [] },
        },
        readySelector: 'li',
        retryText: 'Повторить чтение',
    },
    {
        id: 'docker-containers',
        file: 'src/views/docker/DockerContainers.vue',
        pending: {},
        state: { loading: true, containers: [] },
        readyState: {
            loading: false,
            containers: [
                {
                    id: 'fixture',
                    name: 'Синтетический контейнер',
                    image: 'fixture:1',
                    state: 'running',
                    status: 'Up',
                    health: '',
                    ports: [],
                    compose: null,
                }
            ],
        },
        emptyState: { loading: false, containers: [] },
        readySelector: '.docker-row',
    },
    {
        id: 'docker-usage',
        file: 'src/views/docker/DockerCleanup.vue',
        pending: {},
        state: {
            usageLoading: true,
            usage: null,
            usageError: ''
        },
        readyState: { usageLoading: false, usage: usageDto },
        emptyState: { usageLoading: false, usage: null },
        readySelector: '.docker-usage',
    },
    {
        id: 'studio3d-library',
        file: 'src/views/studio3d/LibraryPanel.vue',
        pending: {},
        state: {
            query: '',
            filters: {},
            models: [],
            busy: 1,
            total: 0,
            broken: [],
            state: { providers: [] }
        },
        readyState: {
            busy: 0,
            models: [modelDto()],
            total: 1
        },
        emptyState: {
            busy: 0,
            models: [],
            total: 0
        },
        readySelector: '[data-context="studio-model-card"]',
    },

    {
        id: 'settings-devices',
        file: 'src/views/settings/DevicesPanel.vue',
        pending: {},
        endpoint: /^\/api\/devices$/,
        response: {
            listener: { state: 'online', addresses: [] },
            devices: [
                {
                id: 'fixture-device',
                name: 'Синтетическое устройство',
                scope: 'client',
                lastSeenAt: 100,
                revokedAt: null,
            }
            ],
        },
        readySelector: '.device-row',
    },
];
