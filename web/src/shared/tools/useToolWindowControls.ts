import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { SurfaceDocument } from '../../../../shared/desktop/surfaceContract.ts';
import type {
  ToolWindowAction,
  ToolWindowControlResult,
} from '../../../../shared/desktop/toolWindowContract.ts';
import { hasOpenModal, showToast, t } from '../../ui.ts';
import { shellAction } from '../shellClient.ts';

/**
 * Управляет конкретным native-окном, не обращаясь к кнопкам главного документа.
 * Resize и focus сверяют максимизацию без отдельного опроса или потока событий.
 */
export function useToolWindowControls(target: () => SurfaceDocument | null, ready: () => boolean) {
  const maximized = ref(false);
  const busy = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let sequence = 0;

  /**
   * Instance входит в каждый запрос, чтобы старая страница не управляла новым окном.
   * Поздний ответ после смены target или unmount не меняет состояние кнопок.
   */
  async function request(action: ToolWindowAction): Promise<void> {
    const document = target();

    if (!ready() || document?.kind !== 'tool' || !document.instance) {
      return;
    }

    const current = ++sequence;
    const result = await shellAction('POST', '/surfaces/tool', {
      action,
      id: document.id,
      instance: document.instance,
    }) as ToolWindowControlResult;

    if (!result.accepted) {
      throw new Error(t('core.coreOknoInstrumentaNedostupno'));
    }

    if (!disposed && current === sequence && target()?.instance === document.instance) {
      maximized.value = result.maximized;
    }
  }

  function refresh(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void request('window-state').catch(() => {});
    }, 100);
  }

  /**
   * Модальный слой и незавершённое действие блокируют повторное управление окном.
   * Ошибка мутации видима человеку; фоновые сверки не создают повторяющихся тостов.
   */
  async function control(action: Exclude<ToolWindowAction, 'window-state'>): Promise<void> {
    if (busy.value || hasOpenModal()) {
      return;
    }

    busy.value = true;

    try {
      await request(action);
    } catch {
      showToast({
        id: 'tool-window-control-failed',
        tone: 'danger',
        title: t('desktop.windowActionFailed'),
      });
    } finally {
      busy.value = false;
    }
  }

  watch(() => ready() && target()?.instance, refresh, { immediate: true });
  onMounted(() => {
    window.addEventListener('resize', refresh);
    window.addEventListener('focus', refresh);
  });
  onBeforeUnmount(() => {
    disposed = true;
    clearTimeout(timer);
    window.removeEventListener('resize', refresh);
    window.removeEventListener('focus', refresh);
  });

  return {
    maximized,
    busy,
    control,
  };
}
