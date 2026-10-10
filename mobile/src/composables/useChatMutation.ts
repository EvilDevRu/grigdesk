import { ref, shallowRef } from 'vue';

import { ApiError } from '../api/client.ts';
import type { OperationIntent } from '../link/types.ts';
import { useLinkStore } from '../stores/link.ts';

/**
 * Неопределённый исход сохраняет точное намерение и блокирует редактирование формы.
 * Повтор использует прежний ключ; доказанный отказ позволяет принять новое решение.
 */
export function useChatMutation() {
  const link = useLinkStore();
  const busy = ref(false);
  const error = ref('');
  const intent = shallowRef<OperationIntent>();

  /**
   * Ошибку видит человек, а durable очередь остаётся источником истины при уходе со страницы.
   * Успех очищает намерение только после подтверждённого сервером результата.
   */
  async function run<T>(action: (saved?: OperationIntent) => Promise<T>): Promise<T | undefined> {
    if (busy.value) {
      return;
    }

    busy.value = true;
    error.value = '';

    try {
      const result = await action(intent.value);

      intent.value = undefined;

      return result;
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'Действие не подтверждено.';

      if (failure instanceof ApiError && failure.operation) {
        if (failure.status >= 400 && failure.status < 500
          && !['operation_unknown', 'idempotency_conflict'].includes(failure.code)) {
          await link.api!.link.removeOutbox({ idempotencyKey: failure.operation.idempotencyKey });
          intent.value = undefined;
        } else {
          intent.value = failure.operation;
          error.value += ' Повтор проверит то же действие. Оно также доступно в настройках.';
        }
      }
    } finally {
      busy.value = false;
    }
  }

  return {
    busy,
    error,
    intent,
    run,
  };
}
