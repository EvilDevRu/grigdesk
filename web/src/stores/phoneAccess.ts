import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import { api, ApiError } from '../shared/apiClient.ts';
import { confirmDialog, messageRef, t } from '../ui.ts';
import { useAuthStore } from './auth.ts';
import { useShellStore } from './shell.ts';

export interface PhoneAccessStatus {
  name: string;
  source: 'saved' | 'env' | 'off';
  direct: {
    enabled?: boolean;
    state: string;
    addresses: (string | { host: string; port: number })[];
    error?: string | null;
  };
  networks: {
    name: string;
    host?: string;
    address?: string;
  }[];
  relays: {
    id: string;
    name: string;
    compatibility?: string;
    enabled?: boolean;
    phoneEligible?: boolean;
    phoneError?: string | null;
    link: {
      state: string;
      compatibility?: string;
      lastError?: string | null;
    };
  }[];
}

interface PhoneCode {
  text: string;
  svg: string;
  expiresInMs: number;
  attemptId: string;
  includedRelayId?: string | null;
}

type PhoneRelayStatus = PhoneAccessStatus['relays'][number];

/**
 * Готовность ретранслятора для телефона решает сервер (phoneEligible): он же учитывает
 * адрес и включённость. Прежний DTO без этого поля читается по состоянию связи.
 */
export function phoneRelayReady(relay: PhoneRelayStatus): boolean {
  if (relay.phoneEligible !== undefined) {
    return relay.phoneEligible;
  }

  return relay.link.state === 'online'
    && (relay.link.compatibility ?? relay.compatibility) === 'supported';
}

/**
 * Сетевое исключение заменяется переводимой подсказкой с дальнейшим действием.
 * Ответ сервера сохраняет причину отказа рядом с этой подсказкой.
 */
function requestFailure(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? `${fallback} ${cause.message}` : fallback;
}

/**
 * Код отказа сервера (например, choose_address) выбирает следующий шаг диалога.
 * Сам код не показывается человеку и не становится ключом перевода.
 */
function serverCode(cause: unknown): string {
  const data = cause instanceof ApiError ? cause.data as { error?: unknown } | null : null;

  return typeof data?.error === 'string' ? data.error : '';
}

/**
 * Сценарий принадлежит выбранному серверу и текущей сессии, QR живёт только в памяти.
 * Каждая асинхронная ветка сверяет поколение даже при непослушной отмене fetch.
 */
export const usePhoneAccessStore = defineStore('phoneAccess', () => {
  const shell = useShellStore();
  const auth = useAuthStore();
  const owner = computed(() => `${shell.profile?.id ?? 'origin'}:${auth.clientScope}`);
  const open = ref(false);
  const status = ref<PhoneAccessStatus | null>(null);
  const code = ref<PhoneCode | null>(null);
  const busy = ref(false);
  const error = ref('');
  const errorCode = ref('');
  const progressError = ref('');
  const progress = ref('pending');
  const connectedDevice = ref<{ id: string; name?: string } | null>(null);
  const seconds = ref(0);
  const copied = ref(false);
  let generation = 0;
  let codeGeneration = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let poll: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;

  function current(epoch: number): boolean {
    return open.value && generation === epoch && auth.authenticated;
  }

  function currentCode(epoch: number, revision: number): boolean {
    return current(epoch) && codeGeneration === revision;
  }

  /**
   * Закрытие уничтожает секреты, таймеры и все ответы прежнего поколения.
   * Повторное открытие не наследует незавершённую выдачу или сетевую ошибку.
   */
  function close(): void {
    generation += 1;
    controller?.abort();
    controller = null;

    if (timer) {
      clearInterval(timer);
    }

    if (poll) {
      clearTimeout(poll);
    }

    timer = null;
    poll = null;
    open.value = false;
    code.value = null;
    status.value = null;
    error.value = '';
    errorCode.value = '';
    progressError.value = '';
    busy.value = false;
    copied.value = false;
    seconds.value = 0;
    progress.value = 'pending';
    connectedDevice.value = null;
  }

  /**
   * Опрос подтверждает authenticated hello, а не сам факт выпуска QR.
   * Ответ относится к конкретной выдаче даже внутри одного открытого диалога.
   */
  function scheduleProgress(epoch: number, revision: number): void {
    if (poll) {
      clearTimeout(poll);
    }

    poll = setTimeout(async () => {
      if (!currentCode(epoch, revision) || !code.value || !seconds.value) {
        return;
      }

      try {
        const value = await api.get(`/api/devices/phone-pairing/${code.value.attemptId}`,
          { signal: controller?.signal, retry: false }) as {
            status: string;
            device?: { id: string; name?: string };
          };

        if (!currentCode(epoch, revision)) {
          return;
        }

        progress.value = value.status;
        progressError.value = '';

        if (value.status === 'connected' && value.device) {
          connectedDevice.value = value.device;
          clearCode();
        } else if (value.status === 'expired') {
          clearCode();
        }
      } catch {
        if (currentCode(epoch, revision)) {
          progressError.value = t('settings.phoneProgressUnavailable');
        }
      }

      if (currentCode(epoch, revision) && progress.value === 'pending') {
        scheduleProgress(epoch, revision);
      }
    }, 2000);
  }

  /**
   * Готовый доступ выдаёт QR одним явным действием без обязательного имени и адреса.
   * Каждая выдача отсекает прежний опрос, срок и асинхронное копирование.
   * Срок отсчитывается монотонно независимо от часов выбранного сервера.
   */
  async function issue(selection: { direct?: { host: string; port: number }[]; relayId?: string } = {}) {
    if (!open.value || !auth.authenticated) {
      return;
    }

    const epoch = generation;

    clearCode();

    const revision = codeGeneration;

    busy.value = true;
    error.value = '';
    errorCode.value = '';
    progressError.value = '';
    code.value = null;
    seconds.value = 0;
    copied.value = false;
    progress.value = 'pending';
    connectedDevice.value = null;

    try {
      const result = await api.post('/api/devices/phone-pairing', selection,
        { signal: controller?.signal, retry: false }) as PhoneCode;

      if (!currentCode(epoch, revision)) {
        return;
      }

      code.value = result;
      deadline = performance.now() + Math.max(0, result.expiresInMs);
      seconds.value = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));

      timer = setInterval(() => {
        if (!currentCode(epoch, revision)) {
          return;
        }

        seconds.value = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));

        if (!seconds.value) {
          progress.value = 'expired';
          clearCode();
        }
      }, 250);
      scheduleProgress(epoch, revision);
    } catch (cause) {
      if (currentCode(epoch, revision)) {
        error.value = requestFailure(cause, t('settings.phoneIssueFailed'));
        errorCode.value = serverCode(cause);
      }
    } finally {
      if (currentCode(epoch, revision)) {
        busy.value = false;
      }
    }
  }

  /**
   * Фоновое обновление статуса не перевыпускает код и использует общий origin API.
   * Данные старого сервера отбрасываются после любого закрытия или смены авторизации.
   */
  async function refresh(): Promise<void> {
    const epoch = generation;
    const value = await api.get('/api/devices/access', { signal: controller?.signal }) as PhoneAccessStatus;

    if (current(epoch)) {
      status.value = value;
    }
  }

  /**
   * Открытие явно выпускает код только при готовом пути выбранного сервера.
   * Выключенный вход сначала показывает управляемое включение, без пустого POST.
   */
  async function start(): Promise<void> {
    close();
    open.value = true;
    busy.value = true;
    controller = new AbortController();

    const epoch = generation;

    try {
      await refresh();

      if (current(epoch) && (status.value?.direct.state === 'online'
        || status.value?.relays.some(phoneRelayReady))) {
        await issue();
      }
    } catch (cause) {
      if (current(epoch)) {
        error.value = requestFailure(cause, t('settings.phoneStatusUnavailable'));
      }
    } finally {
      if (current(epoch)) {
        busy.value = false;
      }
    }
  }

  /**
   * Очистка секрета завершает опрос, срок и поздние действия текущей выдачи.
   * Подтверждённое устройство хранится отдельно и не наследует срок QR.
   */
  function clearCode(): void {
    codeGeneration += 1;

    if (timer) {
      clearInterval(timer);
    }

    if (poll) {
      clearTimeout(poll);
    }

    timer = null;
    poll = null;
    code.value = null;
    seconds.value = 0;
    copied.value = false;
  }

  /**
   * Настройка адресована текущему origin и применяется без перезапуска HTTP.
   * После смены владельца ответ не выпускает код на другом сервере. Телефон, успевший
   * подключиться во время запроса, сохраняет успех: новый QR ему уже не нужен.
   */
  async function configureDirect(enabled: boolean, host?: string, port?: number): Promise<void> {
    const epoch = generation;
    let applied = false;

    busy.value = true;
    error.value = '';
    errorCode.value = '';

    try {
      await api.put('/api/devices/access/direct', enabled
        ? { enabled, addresses: [{ host, port }] } : { enabled });
      applied = true;

      if (!current(epoch)) {
        return;
      }

      if (connectedDevice.value) {
        await refresh();

        return;
      }

      clearCode();
      await refresh();

      if (current(epoch) && !connectedDevice.value) {
        progress.value = 'pending';

        if (enabled || status.value?.relays.some(phoneRelayReady)) {
          await issue();
        }
      }
    } catch (cause) {
      if (current(epoch)) {
        error.value = requestFailure(cause, t(applied ? 'settings.phoneStatusUnavailable'
          : enabled ? 'settings.phoneEnableFailed' : 'settings.phoneDisableFailed'));
      }
    } finally {
      if (current(epoch)) {
        busy.value = false;
      }
    }
  }

  function enable(host: string, port: number): Promise<void> {
    return configureDirect(true, host, port);
  }

  /**
   * Выключение требует общего подтверждения и сохраняет private relay-вход.
   * Смена сервера во время вопроса отменяет применение принятого решения.
   */
  async function disable(): Promise<void> {
    const epoch = generation;

    const confirmed = await confirmDialog(messageRef('settings.phoneDisableConfirm'), {
      danger: true,
      touchTargets: true,
    });

    if (confirmed && current(epoch)) {
      await configureDirect(false);
    }
  }

  /**
   * Явное обновление сначала перечитывает готовность relay выбранного сервера.
   * Прежний код не объявляется пригодным вне дома после одного изменения статуса.
   */
  async function renew(selection: Parameters<typeof issue>[0] = {}): Promise<void> {
    const epoch = generation;

    if (busy.value) {
      return;
    }

    busy.value = true;

    try {
      await refresh();

      if (current(epoch) && !connectedDevice.value) {
        await issue(selection);
      }
    } catch (cause) {
      if (current(epoch)) {
        error.value = requestFailure(cause, t('settings.phoneStatusUnavailable'));
      }
    } finally {
      if (current(epoch)) {
        busy.value = false;
      }
    }
  }

  /**
   * Повтор сети перечитывает интерфейсы сервера без выдачи кода и изменения входов.
   * Ошибка и окончание запроса не переходят в диалог другого поколения.
   */
  async function reload(): Promise<void> {
    const epoch = generation;

    busy.value = true;
    error.value = '';

    try {
      await refresh();
    } catch (cause) {
      if (current(epoch)) {
        error.value = requestFailure(cause, t('settings.phoneStatusUnavailable'));
      }
    } finally {
      if (current(epoch)) {
        busy.value = false;
      }
    }
  }

  /**
   * Имя меняется у подтверждённого устройства, без повторной выдачи секрета.
   * Ответ прежнего сервера не обновляет новый диалог.
   */
  async function rename(name: string): Promise<void> {
    const epoch = generation;
    const device = connectedDevice.value;

    if (!device || !name.trim() || busy.value) {
      return;
    }

    busy.value = true;
    error.value = '';

    try {
      await api.patch(`/api/devices/${encodeURIComponent(device.id)}`, { name: name.trim() });

      if (current(epoch)) {
        connectedDevice.value = { ...device, name: name.trim() };
      }
    } catch (cause) {
      if (current(epoch)) {
        error.value = requestFailure(cause, t('settings.phoneRenameFailed'));
      }
    } finally {
      if (current(epoch)) {
        busy.value = false;
      }
    }
  }

  /**
   * Буфер получает только ещё действующий код открытого поколения.
   * Позднее завершение копирования не меняет состояние нового диалога.
   */
  async function copy(): Promise<void> {
    const epoch = generation;
    const revision = codeGeneration;
    const text = code.value?.text;

    if (!text || !seconds.value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);

      if (currentCode(epoch, revision)) {
        copied.value = true;
      }
    } catch {
      if (currentCode(epoch, revision)) {
        error.value = t('settings.phoneCopyManually');
      }
    }
  }

  watch([owner, () => auth.authenticated], close, { flush: 'sync' });

  return {
    open,
    status,
    code,
    busy,
    error,
    errorCode,
    progressError,
    progress,
    connectedDevice,
    seconds,
    copied,
    start,
    close,
    issue,
    enable,
    disable,
    renew,
    reload,
    rename,
    copy,
    refresh,
  };
});
