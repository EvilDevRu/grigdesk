// Оповещения пользователю: системная нотификация, если доступна и разрешена,
// иначе — мигание заголовком вкладки. Notification API требует secure context
// (https/localhost) — на http://<ip> молча падаем в фоллбэк.
// Задел на будущее: тот же интерфейс сможет дёргать Electron-обёртка.

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
 * Абсолютный адрес иконки собирается от текущего документа и базы интерфейса.
 * Уведомление получает тот же адрес ресурса, который обслуживает origin страницы.
 */
function notificationIcon(): string {
  const base = import.meta.env?.BASE_URL || './';

  try {
    return new URL(`${base}icon-96.png`, window.location.href).href;
  } catch {
    return `${base}icon-96.png`;
  }
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
    // На Android установленная PWA не разрешает `new Notification()` и бросает
    // Illegal constructor. showNotification() активной регистрации — штатный путь и
    // для Android, и для десктопа. URL нужен обработчику notificationclick в SW.
    const options: NotificationOptions = {
      body,
      tag: tag || undefined,
      icon: notificationIcon(),
      data: { url: url || (typeof window !== 'undefined' ? window.location.href : '') },
    };

    try {
      const registration = typeof navigator !== 'undefined'
        ? await navigator.serviceWorker?.getRegistration?.()
        : null;

      if (typeof registration?.showNotification === 'function') {
        await registration.showNotification(title, options);

        return true;
      }
    } catch { /* попробуем обычный Notification (десктоп без живого SW) */ }

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
    // Закрытие экземпляра не блокирует очистку канала service worker.
  }

  try {
    const registration = typeof navigator !== 'undefined'
      ? await navigator.serviceWorker?.getRegistration?.() : null;
    const notifications = await registration?.getNotifications?.({ tag });

    notifications?.forEach((notification) => notification.close());
  } catch {
    // Канал ОС может исчезнуть вместе с регистрацией service worker.
  }
}
