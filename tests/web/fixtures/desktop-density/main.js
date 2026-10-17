import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { router } from '../../../../web/src/router.js';
import { useProvidersStore } from '../../../../web/src/stores/providers.js';
import { useBoardStore } from '../../../../web/src/stores/board.js';
import { useTaskSeenStore } from '../../../../web/src/stores/task-seen.js';
import { useNotifyWatchStore } from '../../../../web/src/stores/notify-watch.js';
import { useDockStore } from '../../../../web/src/stores/dock.js';
import { useChatStore } from '../../../../web/src/stores/chat.js';
import { useSystemStore } from '../../../../web/src/stores/system.js';
import App from './App.vue';
import Controls from './Controls.vue';
import Consumers from './Consumers.vue';
import '../../../../web/src/styles/index.css';

const pinia = createPinia();

setActivePinia(pinia);

// Метрики принадлежат сцене: renderer не читает нагрузку и адреса рабочей машины.
// Полная строка статусов нужна для проверки шрифтов, выравнивания и узкого окна.
useSystemStore().$patch({
  data: {
    cpu: {
      percent: 12,
      cores: 8,
      load1: 0.8,
    },
    mem: {
      percent: 25,
      usedGb: 8,
      totalGb: 32,
    },
    net: {
      ip: '192.0.2.10',
      country: 'Синтетическая сеть',
      countryCode: 'NL',
    },
  },
  stale: false,
});

router.addRoute({ path: '/density-consumers', component: Consumers });
router.addRoute({
  path: '/density-controls',
  component: Controls,
  meta: { title: 'Фикстура контролов' }
});
await router.push('/chats');
await useChatStore()._load();
createApp(App).use(pinia).use(router).mount('#app');
window.densityFixture = {
  chat: useChatStore(),
  dock: useDockStore(),
  board: useBoardStore(),
  seen: useTaskSeenStore(),
  notify: useNotifyWatchStore(),
  providers: useProvidersStore(),
  router
};
