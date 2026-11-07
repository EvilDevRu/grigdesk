import type { InjectionKey } from 'vue';
import { isRecord } from '../../../../shared/lib/objects.ts';
import {
  defineComponent,
  inject,
  onUnmounted,
  provide,
  watch,
} from 'vue';
import { api } from '../../shared/apiClient.ts';
import { useChatStore } from '../../stores/chat.ts';
import {
  createDictationController,
  speechExecutionFingerprint,
} from './controller.ts';

export const DICTATION_CONTROLLER_KEY: InjectionKey<ReturnType<typeof createDictationController>>
  = Symbol('grigdesk-dictation-controller');

/**
 * Фабрика нужна тестам lifecycle. Production-export ниже использует реальные Pinia/API.
 * Component принадлежит рабочей ветке App.vue: offline в оболочке сохраняет controller.
 * Размонтирование рабочей области уничтожает его вместе со всеми browser resources.
 */
export function createSpeechProvider({
  useChatStore: chatStoreFactory = useChatStore,
  controllerFactory = createDictationController,
  apiClient = api,
}: {
  useChatStore?: typeof useChatStore;
  controllerFactory?: typeof createDictationController;
  apiClient?: typeof api;
} = {}) {
  return defineComponent({
    name: 'SpeechProvider',
    /**
     * Авторизованная ветка владеет одним контроллером для всех потребителей речи.
     * Синхронный watcher настроек и cleanup принадлежат тому же lifecycle.
     */
    setup(_props, { slots }) {
      const chat: { speech: unknown; setSpeechSnapshot?: (payload: unknown) => unknown } = chatStoreFactory();
      const controller = controllerFactory({
        settings: {
          read: () => chat.speech,
          apply: (payload) => (typeof chat.setSpeechSnapshot === 'function'
            ? chat.setSpeechSnapshot(payload)
            : (chat.speech = (isRecord(payload) ? payload.settings || payload.speech : null) || payload)),
        },
        apiClient,
      });

      provide(DICTATION_CONTROLLER_KEY, controller);

      const stopSettingsWatch = watch(
        () => speechExecutionFingerprint(chat.speech),
        () => controller.syncSettings(chat.speech),
        { flush: 'sync' },
      );

      onUnmounted(() => {
        stopSettingsWatch();
        void controller.dispose();
      });

      return () => slots.default?.();
    },
  });
}

export const SpeechProvider = createSpeechProvider();

/**
 * Возвращает общий контроллер авторизованной рабочей области.
 * Использование вне provider остаётся явной ошибкой владельца компонента.
 */
export function useDictationController() {
  const controller = inject(DICTATION_CONTROLLER_KEY, null);

  if (!controller) {
    throw new Error('Dictation controller доступен только внутри authenticated SpeechProvider');
  }

  return controller;
}
