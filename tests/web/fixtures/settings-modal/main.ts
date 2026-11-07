import { createApp, h, onMounted, onBeforeUnmount, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createWebHashHistory, RouterView } from 'vue-router';
import { UiButton, UiDialogHost } from '../../../../web/src/ui.ts';
import { useSettingsStore } from '../../../../web/src/stores/settings.ts';
import {
  installSettingsRouteGuard,
  installSettingsOpenListener,
} from '../../../../web/src/shared/settingsNavigation.ts';
import SettingsModal from '../../../../web/src/views/settings/SettingsModal.vue';
import SettingsRouteStub from '../../../../web/src/views/settings/settingsRouteStub.ts';
import '../../../../web/src/styles/index.css';

const pinia = createPinia();

setActivePinia(pinia);

const settings = useSettingsStore();
const counters = reactive({
  mounted: 0,
  unmounted: 0,
  text: '',
});
const Page = {
  setup() {
    onMounted(() => {
      counters.mounted += 1;
    });
    onBeforeUnmount(() => {
      counters.unmounted += 1;
    });

    return () => h('section', { 'data-fixture-route': true }, [
      h('textarea', {
        'aria-label': 'Текст основной страницы',
        value: counters.text,
        onInput: (event: Event) => {
          counters.text = (event.target as HTMLTextAreaElement).value;
        },
      }),
      h('div', { 'data-fixture-scroll': true, style: 'height:160px;overflow:auto' }, [
        h('div', { style: 'height:1500px' }, 'Прокручиваемая основная страница'),
      ]),
      h('a', { href: '#/settings', 'data-fixture-settings-link': true }, 'Настройки ссылкой'),
    ]);
  },
};
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/fixture' },
    { path: '/fixture', component: Page },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsRouteStub,
    },
    {
      path: '/board',
      name: 'board',
      component: Page,
    },
  ],
});

installSettingsRouteGuard(router, settings);
installSettingsOpenListener(window, (request) => settings.requestOpen(request));

const app = createApp({
  render: () => h('main', [
    h('h1', 'Изолированный стенд настроек'),
    h(UiButton, { onClick: () => settings.requestOpen({ pageId: 'interface.behavior' }) },
      () => 'Открыть настройки'),
    h(RouterView),
    h(UiDialogHost),
    h(SettingsModal),
  ]),
});

app.use(pinia).use(router);
await router.isReady();
settings.setAuthenticated(true);
app.mount('#app');
Object.assign(window, { settingsFixture: {
  settings,
  router,
  counters,
} });
