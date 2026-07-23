import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { registerSW } from 'virtual:pwa-register';
import { router } from './router.js';
import { usePwaStore } from './stores/pwa.js';
import App from './App.vue';
import './styles.css';

const pinia = createPinia();
createApp(App).use(pinia).use(router).mount('#app');

// ВАЖНО: НЕ вешаем глобальный слушатель controllerchange с reload() — с включённым
// в DevTools «Update on reload» воркер обновляется на каждую загрузку, controllerchange
// сыпется постоянно, и такой слушатель зациклил бы перезагрузки (страница висла).
// Перезагрузку делает штатный updateSW(true) — он ставит разовый обработчик только
// при клике пользователя по «Обновить» (см. stores/pwa.js).

// Регистрация service worker: при появлении новой версии показываем баннер «Обновить».
const updateSW = registerSW({
  onNeedRefresh() { usePwaStore(pinia).onNeedRefresh(updateSW); },
  onRegisteredSW(swUrl, r) {
    if (!r) return;
    // Периодически опрашиваем сервер на новую версию, чтобы баннер появлялся сам,
    // без ручной перезагрузки страницы. Плюс проверка при возврате на вкладку.
    const check = () => { if (!document.hidden) r.update().catch(() => {}); };
    setInterval(check, 30 * 1000);
    document.addEventListener('visibilitychange', check);
  },
});

