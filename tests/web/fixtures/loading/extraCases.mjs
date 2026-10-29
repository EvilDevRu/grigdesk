import { makeDraft } from '../../../fixtures/routes-editor.mjs';

const draft = makeDraft();
const routeId = Object.keys(draft.routes)[0];
const policyNode = draft.routes[routeId].route.nodes.find((node) => node.executor === 'agent');
export const extraProps = [{
        id: 'showcase-source',
        file: 'src/views/showcase/ShowcaseSourcePanel.vue',
        pending: {
            project: {
                id: 'fixture',
              ref: {
                    kind: 'sandbox',
                  id: '42'
                },
              target: {
                    status: 'ready'
                },
                scenes: [],
              source: null
            },
            options: null,
            loading: true,
            error: '',
            busy: false,
        },
        ready: {
            loading: false,
          options: {
                taskAvailable: true,
                noteMax: 2000,
                defaults: {
                    task: true,
                  note: '',
                  code: true,
                    repos: [{
                            name: 'frontend',
                      work: true,
                      commits: ['a'.repeat(40)]
                        }]
                },
                requiresExplicitSelectionConfirmation: false,
                selectedOutsideCatalog: [],
                repos: [{
                        name: 'frontend',
                  branch: 'fixture',
                  workFiles: 1,
                  error: null,
                        commits: [{
                                id: 'a'.repeat(40),
                          subject: 'Синтетическая правка',
                                date: '2026-01-01T00:00:00Z',
                          own: true,
                          merge: false
                            }]
                    }],
            }
        },
        empty: {
            loading: false,
          options: {
                taskAvailable: true,
              noteMax: 2000,
                defaults: {
                    task: true,
                  note: '',
                  code: true,
                  repos: []
                },
              repos: [],
                requiresExplicitSelectionConfirmation: false,
              selectedOutsideCatalog: []
            }
        },
        readySelector: '.source__repo',
        failure: {
            loading: false,
          error: 'Синтетический отказ'
        },
        geometry: ['row', '.source__repo-head', ['x', 'width', 'height']],
    }];
export const extraPorts = [{
        id: 'diff',
        file: 'src/views/diff/DiffPanel.vue',
        pending: {
            taskId: 42
        },
        endpoint: /^\/api\/tasks\/42\/diff$/,
        response: {
            repos: [{
                    name: 'frontend',
              branch: 'fixture',
              files: [{
                            path: 'readme.txt',
                      status: 'M',
                      oldContent: 'Было',
                      newContent: 'Стало',
                      add: 1,
                      del: 1,
                        }]
                }]
        },
        emptyResponse: {
            repos: []
        },
        readySelector: '.editorwrap',
        geometry: ['tree', '.filelist', ['x', 'width']],
    }, {
        id: 'routes-policy',
        file: 'src/views/routes/RouteNodeInspector.vue',
        pending: {
            document: draft,
          scope: {
                kind: 'route',
              routeId: routeId
            },
            nodeId: policyNode.id,
          capabilities: null
        },
        port: 'routes-policy',
        endpoint: /^\/fixture\/effective-policy$/,
        response: {
            runKey: policyNode.runKey,
          primary: 'fixture-provider',
          failover: [],
          source: 'project',
          models: {}
        },
        readySelector: '.route-node-options:last-child p:nth-of-type(2)',
        openDetails: '.route-node-options:last-child',
        geometry: ['row', '.route-node-options:last-child p:nth-of-type(2)', ['x', 'width']],
    }, {
        id: 'shelf',
        file: 'src/views/shelf/TaskShelfPanel.vue',
        pending: {},
        state: {
            loading: true,
          loaded: false,
          error: null,
          rows: []
        },
        readyState: {
            loading: false,
          loaded: true,
          rows: [{
                    taskId: '42',
              title: 'Синтетическая задача',
              addedAt: '2026-01-01T00:00:00Z',
                    reasonText: 'Жду оценку',
              state: 'neutral',
              completed: false,
              message: '',
              source: null,
                    details: {
                        project: 'Проект',
                      responsible: 'Исполнитель',
                      deadline: '',
                      overdue: false,
                        unread: 0,
                      activities: []
                    },
                }]
        },
        emptyState: {
            loading: false,
          loaded: true,
          rows: []
        },
        readySelector: '[data-task-id="42"]',
        geometry: ['row', '[data-task-id="42"]', ['x', 'width']],
    }, {
        id: 'sandboxes',
        file: 'src/views/SandboxesView.vue',
        pending: {},
        state: {
            loading: true,
          loaded: false,
          error: '',
          profiles: [],
          sandboxes: [],
          jobs: [],
            busyTasks: [],
          capableProfiles: [],
          manualSandboxes: [],
          pipelineSandboxes: [],
          orphanJobs: [],
            manualRange: {
                from: 990000,
              to: 999999
            }
        },
        readyState: {
            loading: false,
          loaded: true,
          profiles: [{
                    id: 'fixture',
              canRaise: true
                }],
            sandboxes: [{
                    task: '990000',
              profile: 'fixture',
              owner: 'manual',
              slot: 0,
              repos: [],
                    standAlive: true,
              removable: true,
              removableReason: null,
              updatedAt: null
                }]
        },
        emptyState: {
            loading: false,
          loaded: true,
          profiles: [],
          sandboxes: []
        },
        readySelector: '.sandbox-row',
        geometry: ['row', '.sandbox-row', ['x', 'width']],
    }];
export const monacoPort = `
export const READONLY_OPTS = {};
export const langOf = () => 'plaintext';
export const monaco = { editor: {
  createModel: () => ({ dispose() {} }),
  createDiffEditor: () => ({ setModel() {}, dispose() {}, updateOptions() {} }),
} };
`;
/**
 * Заполняет только внешние операции store, которые не участвуют в геометрии.
 * Списки и их контейнеры продолжает строить настоящий продуктовый компонент.
 */
export function prepareStore(store) {
    store.isPending = () => false;
    store.jobOf = () => null;
    store.isBusy = () => false;
}
/**
 * Обе среды получают один и тот же транспортный порт и синтетический store.
 * Подменяются только операции чтения, UI и раскладка остаются продуктовыми.
 */
export function extraStubs() {
    return {
        '../../shared/monaco.ts': monacoPort,
        '../../shared/routesApi.ts': `export const routesApi = {
      effectivePolicy: () => globalThis.__loadingSurface.api('/fixture/effective-policy'),
    };`,
        '../../stores/taskShelf.ts': (
            'export const useTaskShelfStore = () => globalThis.__loadingSurface.store;'
        ),
        '../../stores/ui.ts': 'export const useUiStore = () => ({ openTask() {} });',
        '../actions/sandboxes': `
      export const useSandboxesStore = () => globalThis.__loadingSurface.store;
      export const loadSandboxes = async () => {};
      export const loadSandboxJobLog = async () => ({ text: '', truncated: false });
      export const watchSandboxes = () => {};
      export const dismantleSandbox = async () => {};
      export const raiseSandbox = async () => {};
      export const runSandboxAction = async () => {};
    `,
        '../composables/useUiContextSource.ts': `export const useUiContextSource = () => ({
      focus() {}, update() {}, blur() {},
    });`,
    };
}

const sandboxCase = extraPorts.find((item) => item.id === 'sandboxes');

sandboxCase.readyState.manualSandboxes = sandboxCase.readyState.sandboxes;
extraPorts.push({
    id: 'settings-setup',
    file: 'src/views/settings/pages/PluginSetupPanel.vue',
    pending: {
        plugin: {
            id: 'fixture',
          enabled: true,
          setup: {}
        },
      active: true
    },
    endpoint: /^\/fixture\/setup$/,
    port: 'setup',
    response: {
        items: [{
                id: 'fixture',
          title: 'Синтетическая готовность',
          reason: 'Готово'
            }]
    },
    readySelector: '[data-plugin-setup] b',
    geometry: ['row', '[data-plugin-setup] > div', ['x', 'width']],
});
extraPorts.push({
    id: 'github',
    file: 'src/views/GitHubView.vue',
    pending: {},
    endpoint: /^\/api\/github\/status$/,
    response: {
        configured: false,
      state: null,
      repositoryId: null,
      fullName: null,
      connectedAt: null,
        connection: 'disconnected',
      reason: null,
      cleanupPending: false
    },
    readySelector: '.grid',
    geometry: ['connection', '.grid > :first-child', ['x', 'width']],
    browserOnly: true,
}, {
    id: 'telegram',
    file: 'src/views/TelegramView.vue',
    pending: {},
    endpoint: /^\/api\/telegram\/status$/,
    response: {
        bot: {
            configured: false,
          botId: 0,
          username: '',
          tokenHint: '',
          privacyHint: ''
        },
      poll: null
    },
    readySelector: '.setup-card',
    geometry: ['connection', '.setup-card', ['x', 'width']],
    browserOnly: true,
}, {
    id: 'inbox',
    file: 'src/views/InboxView.vue',
    pending: {},
    endpoint: /^\/api\/inbox$/,
    response: {
        channels: [],
      errors: [],
      truncated: false,
        worker: {
            running: true,
          readiness: 'ready',
          lastReason: '',
          lastError: null
        },
        items: [{
                ref: '[1,"item","github","fixture","issue"]',
          revision: `v1_${'a'.repeat(43)}`,
                channel: {
                    id: 'github',
                  label: 'GitHub'
                },
                source: {
                    title: 'Синтетическое обращение',
                  url: 'https://example.test/issue'
                },
                project: 'fixture',
          kind: 'bug',
          status: 'new',
          decision: null,
          firstAt: 100,
          lastAt: 100,
                cold: true,
          autoTask: {
                    enabled: false,
                  readyAtMs: 100
                },
          title: 'Синтетический заголовок',
                description: 'Синтетическое описание',
          truncated: false,
          messages: [{
                        messageRef: '[1,"message","github","fixture","repo","issue:1"]',
                  occurredAt: 100,
                        editedAt: null,
                  author: {
                            name: 'Синтетический автор'
                        },
                  text: 'Сообщение',
                        attachments: [],
                  decision: null,
                    }],
          attachments: []
            }],
    },
    readySelector: '.item-card',
    geometry: ['header', '.queue-head', ['y', 'height']],
    browserOnly: true,
});
