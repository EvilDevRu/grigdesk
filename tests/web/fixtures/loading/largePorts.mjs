import { reactive, ref } from 'vue';
import { defineStore } from 'pinia';

export const boardData = {
  userId: 7,
  today: {
    hours: 0,
    tasks_count: 0,
    avg_time: 0
  },
  dynamics: {},
  month: {
    hours: 0,
    norm: 1,
    completedTasks: 0
  },
  charts: {},
  tasks: [{
    id: 42,
    title: 'Синтетическая задача',
    group: 'Проект',
    timerElapsed: 0
  }],
  toReview: [],
  created: [],
};
export const board = reactive({
  data: ref(null),
  activity: { unseenCount: 0 },
  error: ref(null),
  loading: ref(true),
  readAt: ref(0),
  clearSource() {},
  async load() {},
  startPolling() {},
  stopPolling() {}
});
export const auth = reactive({
  authenticated: false,
  ready: true,
  logEpoch: 0,
  watchUnauthorized() {},
  stopRecovery() {},
  async load() {},
});
export const shell = reactive({
  initialized: true,
  present: true,
  localAvailable: false,
  capabilities: [],
  status: 'connecting',
  showConnections: false,
  profile: { id: 'fixture', name: 'Синтетическая машина' },
  async start() {},
  stop() {}
});
const ownPersonal = defineStore('loading-large-own-personal', {
  state: () => ({
    loaded: true,
    loading: false,
    error: null,
    initialized: true,
    taskIds: [],
    pending: {},
  }),
  getters: {
    ready: () => true,
    isFavorite: () => () => false,
    isPending: () => () => false,
    isSeen: () => () => true,
    isOnShelf: () => () => false,
  },
  actions: {
    async load() {},
    clear() {},
  },
});
export const passive = defineStore('loading-large-passive', {
  state: () => ({
    loaded: true,
    loading: false,
    error: null,
    ready: true,
    initialized: true,
    data: null,
    stale: false,
    updatedAt: null,
    snapshot: { active: null, recent: {} },
    open: false,
    isExpanded: false,
    issues: [],
    topbarItems: [],
    badgeSummary: { attentionCount: 0 },
    reviewCount: 0,
    rows: [],
    taskIds: [],
    entries: [],
    pending: {},
    byTask: {},
    list: [],
    isOpen: false,
  }),
  getters: {
    own: () => ownPersonal(),
    isFavorite: () => () => false,
    isPending: () => () => false,
    isSeen: () => () => true,
    isOnShelf: () => () => false,
  },
  actions: {
    clear() {},
    async load() {},
    start() {},
    stop() {},
    startPolling() {},
    stopPolling() {},
    setAuthenticated() {},
    dispose() {},
    stopPoll() {},
    openTask() {},
    startAnalysisPolling() {},
  },
});
