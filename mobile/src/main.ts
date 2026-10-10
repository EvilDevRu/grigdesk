import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './App.vue';
import { router } from './router.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/utilities.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/screens.css';

createApp(App).use(createPinia()).use(router).mount('#app');
