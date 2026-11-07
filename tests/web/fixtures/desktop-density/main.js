import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { router } from '../../../../web/src/router.ts';
import { useProvidersStore } from '../../../../web/src/stores/providers.ts';
import { useBoardStore } from '../../../../web/src/stores/board.ts';
import { useTaskSeenStore } from '../../../../web/src/stores/taskSeen.ts';
import { useNotifyWatchStore } from '../../../../web/src/stores/notifyWatch.ts';
import { useDockStore } from '../../../../web/src/stores/dock.ts';
import { useChatStore } from '../../../../web/src/stores/chat.ts';
import { useSystemStore } from '../../../../web/src/stores/system.ts';
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
