import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { chatListPagingStub } from '../../helpers/chat-list.js';

export const counts = reactive({
    ensure: 0,
    sessionMounts: 0,
    loads: 0,
    storage: [],
});
export const useChatStore = defineStore('loading-fixture-chat', {
    state: () => ({
        loaded: false,
        loading: true,
        loadError: null,
        loadErrorMessage: null,
        activeId: 'fixture-chat',
        openedChatIds: ['fixture-chat'],
        revealRequest: '',
        archived: [],
        compactWindow: 0,
        sessions: [
            {
                id: 'fixture-chat',
                title: 'Синтетическая переписка',
                model: 'fixture-model',
                modelRef: { provider: 'fixture-provider', model: 'fixture-model' },
                draft: '',
                draftAttachments: [],
                messages: [],
                steps: [],
                taskId: null,
                effort: '',
                mode: '',
                sending: false,
                compacting: false,
                contextTokens: 0,
                workdirState: { committed: { cwd: '/fixture/project' } },
            }
        ],
    }),
    actions: {
        ...chatListPagingStub(),
        async ensureChatMessages() {},
        setChatViewport() {},
        ensure() {
            counts.ensure += 1;
        },
        list() {
            return this.sessions.map((session) => ({
                ...session,
                ts: 100,
                snippet: 'Синтетическое сообщение'
            }));
        },
        registerSurface: () => ({ update() {
            }, dispose() {
            } }),
        consumeReveal() {
        },
        markRead() {
        },
        loadConveyor() {
        },
        setDraft() {
        },
        permFor: () => null,
        questionFor: () => null,
        isOnConveyor: () => false,
        tabLabel: () => 'Синтетическая переписка',
    },
});
const model = {
    id: 'fixture-model',
    name: 'Модель',
    efforts: []
};
const provider = {
    id: 'fixture-provider',
    name: 'Исполнитель',
    available: true,
    models: [model],
    commands: [],
};
export const providers = {
    providers: [provider],
    load() {
        counts.loads += 1;
    },
    modelOf: () => ({
        id: model.id,
        model,
        provider
    }),
    visibleModels: () => [model],
    modesOf: () => [],
};
export const connected = ref(true);
export const speech = {
    acquire: () => ({
        state: reactive({
            phase: 'idle',
            busy: false,
            prompt: null,
            interim: '',
            notice: ''
        }),
        async release() {
        },
    }),
};
