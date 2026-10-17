// Оповещения пользователю: системная нотификация, если доступна и разрешена,
// иначе — мигание заголовком вкладки. Notification API требует secure context
// (https/localhost) — на http://<ip> молча падаем в фоллбэк.
import { NOTIFICATION_ICON } from './notificationIcon.ts';

let blinkTimer: ReturnType<typeof setInterval> | null = null;
let baseTitle: string | null = null;
const systemNotifications = new Map<string, Notification>();

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
 * Фоллбэк без Notification API: мигаем заголовком вкладки, пока человек не вернётся.
 * Исходный заголовок фиксируется на время мигания — возврат на вкладку обязан
 * восстановить именно его, а не то, что успело смениться по дороге.
 */
function titleBlink(text: string): void {
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
    document.title = on ? `● ${text}` : original;
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
 */
export async function ensureNotifyPermission(): Promise<boolean> {
  const NotificationApi = notificationApi();

  if (!NotificationApi) {
    return false;
  }

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

/**
 * Показать оповещение. `tag` дедуплицирует одинаковые: новое замещает предыдущее
 * с тем же тегом, а не копится в шторке. Возврат говорит, показали ли системное
 * уведомление, — на `false` вызывающий уже ничего не должен делать, фоллбэк отработал.
 */
export async function notify(title: string, body = '', tag = '', url = ''): Promise<boolean> {
  const NotificationApi = notificationApi();

  if (NotificationApi?.permission === 'granted') {
    const options: NotificationOptions = {
      body,
      tag: tag || undefined,
      icon: NOTIFICATION_ICON,
      data: { url: url || (typeof window !== 'undefined' ? window.location.href : '') },
    };

    try {
      const n = new NotificationApi(title, options);

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

  if (typeof document !== 'undefined' && document.hidden) {
    titleBlink(title);
  }

  return false;
}

/**
 * Закрывает системное оповещение с тем же id, что у тоста.
 * Отсутствие доступного канала не мешает остальным действиям окна.
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
}
