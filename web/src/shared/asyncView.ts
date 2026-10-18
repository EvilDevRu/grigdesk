import { defineAsyncComponent } from 'vue';
import type { AsyncComponentLoader, Component } from 'vue';

import LoadFailure from './LoadFailure.vue';

/**
 * Панель обязана завершать ожидание видимым результатом, даже если chunk не загрузился.
 * Обработчик ошибки включён в основной пакет и не зависит от сломанного lazy-ресурса.
 */
export function asyncView(
  loader: AsyncComponentLoader,
  loadingComponent?: Component,
  onLoadError?: (error: Error) => void,
): Component {
  return defineAsyncComponent({
    loader,
    onError: onLoadError ? (error, _retry, fail) => {
      onLoadError(error);
      fail();
    } : undefined,
    loadingComponent,
    errorComponent: LoadFailure,
    delay: 0,
    timeout: 30000,
    suspensible: false,
  });
}
