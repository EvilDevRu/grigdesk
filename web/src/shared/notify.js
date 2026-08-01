// Оповещения пользователю: системная нотификация, если доступна и разрешена,
// иначе — мигание заголовком вкладки. Notification API требует secure context
// (https/localhost) — на http://<ip> молча падаем в фоллбэк.
// Задел на будущее: тот же интерфейс сможет дёргать Electron-обёртка.

let blinkTimer = null;
let baseTitle = null;

function notificationApi() {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  return window.Notification;
}

function notificationIcon() {
  const base = import.meta.env?.BASE_URL || './';
  try { return new URL(`${base}icon-96.png`, window.location.href).href; }
  catch { return `${base}icon-96.png`; }
}

function titleBlink(text) {
  if (blinkTimer) clearInterval(blinkTimer);
  if (baseTitle === null) baseTitle = document.title;
  let on = false;
  blinkTimer = setInterval(() => {
    on = !on;
    document.title = on ? `● ${text}` : baseTitle;
  }, 1200);
  // Возврат на вкладку гасит мигание
  const stop = () => {
    if (!document.hidden) {
      clearInterval(blinkTimer);
      blinkTimer = null;
      document.title = baseTitle;
      document.removeEventListener('visibilitychange', stop);
    }
  };
  document.addEventListener('visibilitychange', stop);
}

/**
 * Разово спросить разрешение на системные нотификации (звать по действию пользователя).
 */
export async function ensureNotifyPermission() {
  const NotificationApi = notificationApi();
  if (!NotificationApi) return false;
  if (NotificationApi.permission === 'granted') return true;
  if (NotificationApi.permission === 'denied') return false;
  try { return (await NotificationApi.requestPermission()) === 'granted'; } catch { return false; }
}

/**
 * Показать оповещение. tag — дедуп одинаковых (замещает предыдущее с тем же tag).
 */
export async function notify(title, body = '', tag = '') {
  const NotificationApi = notificationApi();
  if (NotificationApi?.permission === 'granted') {
    // На Android установленная PWA не разрешает `new Notification()` и бросает
    // Illegal constructor. showNotification() активной регистрации — штатный путь и
    // для Android, и для десктопа. URL нужен обработчику notificationclick в SW.
    const options = {
      body,
      tag: tag || undefined,
      icon: notificationIcon(),
      data: { url: typeof window !== 'undefined' ? window.location.href : '' },
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
      n.onclick = () => { window.focus(); n.close(); };
      return true;
    } catch { /* упадём в фоллбэк */ }
  }
  if (typeof document !== 'undefined' && document.hidden) titleBlink(title);
  return false;
}
