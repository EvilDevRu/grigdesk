import { createApp, h } from 'vue';
import { createPinia } from 'pinia';

import MobileAccess from '../../../../web/src/views/settings/MobileAccess.vue';
import { UiDialogHost } from '../../../../web/src/ui.ts';
import '../../../../web/src/styles/index.css';

const app = createApp({
  render: () => [h(MobileAccess), h(UiDialogHost)],
});

app.use(createPinia());
app.mount('#app');
