import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { registerSW } from 'virtual:pwa-register';
import { router } from './router.js';
import { usePwaStore } from './stores/pwa.js';
import App from './App.vue';
import './styles.css';

const pinia = createPinia();
createApp(App).use(pinia).use(router).mount('#app');

// Регистрация service worker: при появлении новой версии показываем баннер «Обновить».
const updateSW = registerSW({
  onNeedRefresh() { usePwaStore(pinia).onNeedRefresh(updateSW); },
});
