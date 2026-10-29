// Подмены новых связей App не запускают тяжёлые страницы и закрывают выданные каналы.
// Общие gate-тесты продолжают проверять настоящие watchers оболочки и авторизации.
export const appWindowStubs = {
  './shared/onboarding/OnboardingHost.vue': 'export default { render: () => null };',
  './shared/layout/DesktopWindowControls.vue': 'export default { render: () => null };',
  './views/TaskWindowPage.vue': 'export default { render: () => null };',
  './stores/plugins.ts': 'export const usePluginsStore = () => ({ load: async () => {} });',
  './composables/useSse.ts': `export const setSseEnabled = () => {};
    export const sseSubscribe = () => () => {};`,
  './shared/windowRelay.ts': `
    export const startShellRelay = (options) => () => options.channel.close();
    export const startBoardRelay = (options) => () => options.channel.close();
    export const startShelfRelay = (options) => () => options.channel.close();`,
  './shared/taskWindowSync.ts': `
    export const startTaskWindowSync = (options) => () => options.channel.close();
    export const createQueuedReload = () => ({ request() {}, dispose() {} });`,
};
