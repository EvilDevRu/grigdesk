// Подмены новых связей App не запускают тяжёлые страницы и закрывают выданные каналы.
// Общие gate-тесты продолжают проверять настоящие watchers оболочки и авторизации.
export const appWindowStubs = {
  './features/help/HelpDialog.vue': `
    export const __esModule = true;
    export default { render: () => null };`,
  './stores/help.ts': 'export const useHelpStore = () => ({ isOpen: false, close() {} });',
  './shared/helpNavigation.ts': 'export const bindHelpAccess = () => () => {};',
  './stores/documentPreview.ts': 'export const useDocumentPreviewStore = () => ({ href: null });',
  './stores/diff.ts': 'export const useDiffStore = () => ({ open: false, taskId: null });',
  './stores/ui.ts': 'export const useUiStore = () => ({ taskId: null, close() {} });',
  './stores/tasks.ts': 'export const useTasksStore = () => ({ invalidate() {} });',
  './stores/grigdeskTasks.ts': `export const useGrigdeskTasksStore = () => ({
    async load() {}, clear() {},
  });`,
  './shared/layout/DesktopExitHost.vue': 'export default { render: () => null };',
  './shared/layout/DesktopWindowControls.vue': 'export default { render: () => null };',
  './views/ToolWindowPage.vue': 'export default { render: () => null };',
  './views/TaskWindowPage.vue': 'export default { render: () => null };',
  './stores/plugins.ts': 'export const usePluginsStore = () => ({ load: async () => {} });',
  './composables/useSse.ts': `export const setSseEnabled = () => {};
    export const sseSubscribe = () => () => {};`,
  './shared/tools/toolWindowRelay.ts': `
    export const startToolShelfRelay = (options) => () => options.channel.close();`,
  './shared/windowRelay.ts': `
    export const startShellRelay = (options) => () => options.channel.close();
    export const startBoardRelay = (options) => () => options.channel.close();
    export const startShelfRelay = (options) => () => options.channel.close();`,
  './shared/taskWindowSync.ts': `
    export const startTaskWindowSync = (options) => () => options.channel.close();
    export const createQueuedReload = () => ({ request() {}, dispose() {} });`,
};
