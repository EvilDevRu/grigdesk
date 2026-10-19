import {
  defineComponent,
  inject,
  onUnmounted,
  provide,
  watch,
} from 'vue';
import { api } from '../../shared/apiClient.ts';
import { useChatStore } from '../../stores/chat.js';
import {
  createDictationController,
  speechExecutionFingerprint,
} from './controller.js';

export const DICTATION_CONTROLLER_KEY = Symbol('grigdesk-dictation-controller');

/**
 * Фабрика нужна тестам lifecycle. Production-export ниже использует реальные Pinia/API.
 * Component принадлежит рабочей ветке App.vue: offline в оболочке сохраняет controller.
 * Размонтирование рабочей области уничтожает его вместе со всеми browser resources.
 */
export function createSpeechProvider({
  useChatStore: chatStoreFactory = useChatStore,
  controllerFactory = createDictationController,
  apiClient = api,
} = {}) {
  return defineComponent({
    name: 'SpeechProvider',
    setup(_props, { slots }) {
      const chat = chatStoreFactory();
      const controller = controllerFactory({
        settings: {
          read: () => chat.speech,
          apply: (payload) => (typeof chat.setSpeechSnapshot === 'function'
            ? chat.setSpeechSnapshot(payload)
            : (chat.speech = payload?.settings || payload?.speech || payload)),
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

export function useDictationController() {
  const controller = inject(DICTATION_CONTROLLER_KEY, null);
  if (!controller) {
    throw new Error('Dictation controller доступен только внутри authenticated SpeechProvider');
  }
  return controller;
}
