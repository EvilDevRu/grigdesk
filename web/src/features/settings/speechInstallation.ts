import { shallowRef } from 'vue';

import {
  decodeSpeechInstallation,
  type SpeechInstallation,
  type SpeechInstallOperation,
} from '../../../../shared/media/speechInstallation.ts';
import { failureText, type ApiClient } from '../../shared/apiClient.ts';
import { confirmDialog, t } from '../../ui.ts';

/**
 * Открытие настроек хранит один установщик для всех страниц речи.
 * Потеря ответа уточняется чтением состояния и никогда не повторяет POST автоматически.
 */
export function createSpeechInstallation(
  client: Pick<ApiClient, 'get' | 'post'>,
  refresh: () => Promise<unknown>,
  modelId: () => string = () => 'medium',
) {
  const snapshot = shallowRef<SpeechInstallation | null>(null);
  const error = shallowRef('');
  const busy = shallowRef(false);
  const cuda = shallowRef<boolean | undefined>(undefined);
  const uncertain = shallowRef(false);
  let active = false;
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reads = new AbortController();
  let reading = false;
  let readError = false;
  let previousOutcome: string | null = null;
  const refreshed = new Set<string>();

  /**
   * Итог операции обновляет готовность окружения без применения черновика.
   * Один серверный job обновляет capabilities не более одного раза за открытие.
   */
  async function accept(value: unknown): Promise<void> {
    const next = decodeSpeechInstallation(value);

    if (next.job?.id === previousOutcome) {
      next.job = null;
    } else if (next.job && uncertain.value) {
      error.value = '';
    }

    if (next.job && next.job.status !== 'running' && !refreshed.has(next.job.id)) {
      await refresh();
      refreshed.add(next.job.id);
    }

    snapshot.value = next;
    uncertain.value = false;
  }

  /**
   * Опрос существует только на видимой странице и продолжает прежнюю серверную операцию.
   * Поколение и отмена исключают применение ответа закрытого открытия настроек.
   */
  async function load(): Promise<void> {
    if (disposed || !active || reading) {
      return;
    }

    clearTimeout(timer);
    reading = true;

    const visiting = generation;

    try {
      const response = await client.get('/api/settings/speech/installation', {
        signal: reads.signal,
        retry: false,
      });

      if (!disposed && active && visiting === generation) {
        if (readError) {
          error.value = '';
          readError = false;
        }

        await accept(response);
      }
    } catch (cause) {
      if (!disposed && active && visiting === generation) {
        error.value = failureText(cause);
        readError = true;
      }
    } finally {
      reading = false;

      if (!disposed && active && visiting === generation) {
        timer = setTimeout(() => void load(), snapshot.value?.job?.status === 'running' ? 900 : 5000);
      } else if (!disposed && active) {
        void load();
      }
    }
  }

  /**
   * Подтверждение называет конкретную операцию и сохранение моделей и настроек.
   * Отказ, закрытие настроек и двойное нажатие не запускают установщик.
   */
  async function start(operation: SpeechInstallOperation): Promise<void> {
    if (disposed || busy.value || uncertain.value || !snapshot.value?.managed
      || snapshot.value.job?.status === 'running') {
      return;
    }

    busy.value = true;
    error.value = '';
    readError = false;

    const withCuda = cuda.value;
    const selectedModel = modelId();
    const labels = {
      install: t('settings.speechRuntimeInstall'),
      update: t('settings.speechRuntimeUpdate'),
      uninstall: t('settings.speechRuntimeUninstall'),
    };
    const messages = {
      install: t('settings.speechRuntimeConfirmInstall'),
      update: t('settings.speechRuntimeConfirmUpdate'),
      uninstall: t('settings.speechRuntimeConfirmUninstall'),
    };

    try {
      const confirmed = await confirmDialog(messages[operation], {
        title: labels[operation],
        okText: labels[operation],
        danger: operation === 'uninstall',
      });

      if (!confirmed || disposed) {
        return;
      }

      generation += 1;
      reads.abort();
      reads = new AbortController();
      previousOutcome = snapshot.value?.job?.id ?? previousOutcome;
      snapshot.value = { ...snapshot.value!, job: null };
      uncertain.value = true;

      const body = operation === 'uninstall' ? {} : {
        modelId: selectedModel,
        ...(withCuda === undefined ? {} : { cuda: withCuda }),
      };
      const response = await client.post(`/api/settings/speech/installation/${operation}`, body);

      if (!disposed) {
        await accept(response);
      }
    } catch (cause) {
      if (!disposed) {
        error.value = failureText(cause);
      }
    } finally {
      busy.value = false;

      if (!disposed) {
        void load();
      }
    }
  }

  /**
   * Переход прекращает только чтения; серверный worker продолжает свою работу.
   * Возврат перечитывает current, включая установку, начатую в другом окне.
   */
  function setActive(value: boolean): void {
    if (disposed || value === active) {
      return;
    }

    active = value;
    generation += 1;
    clearTimeout(timer);
    reads.abort();
    reads = new AbortController();

    if (active) {
      void load();
    }
  }

  function dispose(): void {
    setActive(false);
    disposed = true;
  }

  return {
    snapshot,
    error,
    busy,
    cuda,
    uncertain,
    load,
    start,
    setActive,
    dispose,
  };
}

export type SpeechInstallationController = ReturnType<typeof createSpeechInstallation>;
