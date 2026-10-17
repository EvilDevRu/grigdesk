import { defineAsyncComponent } from 'vue';
import type { AsyncComponentLoader, Component } from 'vue';

import LoadFailure from './LoadFailure.vue';

/**
 * Панель обязана завершать ожидание видимым результатом, даже если chunk не загрузился.
 * Обработчик ошибки включён в основной пакет и не зависит от сломанного lazy-ресурса.
 */
export function asyncView(loader: AsyncComponentLoader, loadingComponent?: Component): Component {
  return defineAsyncComponent({
    loader,
    loadingComponent,
    errorComponent: LoadFailure,
    delay: 0,
    timeout: 30000,
    suspensible: false,
  });
}
