import { getActivePinia } from 'pinia';
import { translator, type LocaleSource } from '../../../shared/i18n/catalogs.ts';
import { snapshotText, type UiText } from '../../../shared/i18n/core.ts';

// Оповещения пользователю: системная нотификация, если доступна и разрешена,
// иначе — мигание заголовком вкладки. Notification API требует secure context
// (https/localhost) — на http://<ip> молча падаем в фоллбэк.
// В APK WebView не реализует Notification API: системный показ идёт через трубу
// оболочки (/__shell/notify), а разрешение спрашивает нативная кнопка настроек.
import { NOTIFICATION_ICON } from './notificationIcon.ts';
import { useShellStore } from '../stores/shell.ts';

export type ShellNotifyPermission = NotificationPermission | 'unsupported';

let blinkTimer: ReturnType<typeof setInterval> | null = null;
let baseTitle: string | null = null;
const systemNotifications = new Map<string, Notification>();
const shellNotifications = new Set<string>();

/**
 * Notification API там, где он вообще есть. Вне браузера и в insecure-контексте
 * его нет — возвращаем null, чтобы решение «показывать или мигать» принималось
 * в одном месте, а не проверкой окружения на каждом вызове.
 */
function notificationApi(): typeof Notification | null {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }

  return window.Notification;
}

/**
 * Нативный канал принадлежит уже обнаруженной оболочке текущего документа.
 * До создания Pinia и в обычном браузере сохраняется браузерное поведение.
 */
export function shellNotifySupported(): boolean {
  const pinia = getActivePinia();

  return Boolean(pinia && useShellStore(pinia).capabilities.includes('notify'));
}

function isNotifyPermission(value: unknown): value is NotificationPermission {
  return value === 'granted' || value === 'denied' || value === 'default';
}

/**
 * Чтение состояния не запускает системный диалог и пригодно для синхронизации настроек.
 * Отказ сети или старая оболочка без канала читаются как unsupported.
 */
export async function readShellNotifyPermission(): Promise<ShellNotifyPermission> {
  if (!shellNotifySupported()) {
    return 'unsupported';
  }

  try {
    const response = await fetch('/__shell/notify-permission', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const result = response.ok ? await response.json() as { permission?: unknown } : null;

    return isNotifyPermission(result?.permission) ? result.permission : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/**
 * Запрос разрешения выполняется только по действию человека и возвращает итоговое состояние.
 * Нативный отказ не считается ошибкой трубы: причина показывается в настройках.
 */
async function requestShellNotifyPermission(): Promise<ShellNotifyPermission> {
  if (!shellNotifySupported()) {
    return 'unsupported';
  }

  try {
    const response = await fetch('/__shell/notify-permission', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = response.ok ? await response.json() as { permission?: unknown } : null;

    return isNotifyPermission(result?.permission) ? result.permission : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/**
 * Фоллбэк без Notification API: мигаем заголовком вкладки, пока человек не вернётся.
 * Исходный заголовок фиксируется на время мигания — возврат на вкладку обязан
 * восстановить именно его, а не то, что успело смениться по дороге.
 */
function titleBlink(text: () => string): void {
  if (blinkTimer) {
    clearInterval(blinkTimer);
  }

  if (baseTitle === null) {
    baseTitle = document.title;
  }

  const original = baseTitle;
  let on = false;

  blinkTimer = setInterval(() => {
    on = !on;
    document.title = on ? `● ${text()}` : original;
  }, 1200);

  // Возврат на вкладку гасит мигание и снимает собственного слушателя: иначе он
  // пережил бы мигание и восстанавливал заголовок при каждом переключении вкладок.
  const stop = () => {
    if (document.hidden) {
      return;
    }

    if (blinkTimer) {
      clearInterval(blinkTimer);
    }

    blinkTimer = null;
    document.title = original;
    document.removeEventListener('visibilitychange', stop);
  };

  document.addEventListener('visibilitychange', stop);
}

/**
 * Разово спросить разрешение на системные нотификации. Звать только по действию
 * человека: браузер отклоняет запрос без жеста и запоминает отказ надолго.
 * В APK запрос уходит нативной оболочке, потому что WebView не умеет спрашивать сам.
 */
export async function ensureNotifyPermission(): Promise<boolean> {
  const NotificationApi = notificationApi();

  if (NotificationApi) {
    if (NotificationApi.permission === 'granted') {
      return true;
    }

    if (NotificationApi.permission === 'denied') {
      return false;
    }

    try {
      return (await NotificationApi.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  return (await requestShellNotifyPermission()) === 'granted';
}

/**
 * Показать оповещение. `tag` дедуплицирует одинаковые: новое замещает предыдущее
 * с тем же тегом, а не копится в шторке. Возврат говорит, показали ли системное
 * уведомление, — на `false` вызывающий уже ничего не должен делать, фоллбэк отработал.
 */
export async function notify(
  title: UiText,
  body: UiText = '',
  tag = '',
  url = '',
  locale: LocaleSource = 'ru',
): Promise<boolean> {
  const savedTitle = snapshotText(title);
  const savedBody = snapshotText(body);
  const resolve = (text: UiText) => translator.resolveText(
    text, typeof locale === 'string' ? locale : locale.value,
  );
  const NotificationApi = notificationApi();

  if (NotificationApi?.permission === 'granted') {
    const options: NotificationOptions = {
      body: resolve(savedBody),
      tag: tag || undefined,
      icon: NOTIFICATION_ICON,
      data: { url: url || (typeof window !== 'undefined' ? window.location.href : '') },
    };

    try {
      const n = new NotificationApi(resolve(savedTitle), options);

      if (tag) {
        systemNotifications.set(tag, n);
      }

      n.onclose = () => {
        if (systemNotifications.get(tag) === n) {
          systemNotifications.delete(tag);
        }
      };
      n.onclick = () => {
        window.focus();

        if (url) {
          window.location.href = url;
        }

        n.close();
      };

      return true;
    } catch { /* упадём в фоллбэк */ }
  }

  if (shellNotifySupported()) {
    try {
      const response = await fetch('/__shell/notify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: resolve(savedTitle),
          body: resolve(savedBody),
          tag,
          url,
        }),
      });
      const result = response.ok ? await response.json() as { shown?: unknown } : null;

      if (result?.shown === true) {
        if (tag) {
          shellNotifications.add(tag);
        }

        return true;
      }
    } catch { /* упадём в фоллбэк */ }
  }

  if (typeof document !== 'undefined' && document.hidden) {
    titleBlink(() => resolve(savedTitle));
  }

  return false;
}

/**
 * Закрывает системное оповещение с тем же id, что у тоста.
 * Отсутствие доступного канала не мешает остальным действиям окна.
 * Нативный канал гасит только те теги, что показал сам, без лишнего запроса в браузерном окне.
 */
export async function closeSystemNotification(tag: string): Promise<void> {
  if (!tag) {
    return;
  }

  try {
    systemNotifications.get(tag)?.close();
    systemNotifications.delete(tag);
  } catch {
    // Канал ОС может исчезнуть вместе с окном приложения.
  }

  if (shellNotifications.delete(tag)) {
    try {
      await fetch('/__shell/notify-cancel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag }),
      });
    } catch {
      // Оболочка могла закрыться вместе с окном; тост уже погашен.
    }
  }
}
