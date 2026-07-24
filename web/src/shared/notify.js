// Оповещения пользователю: системная нотификация, если доступна и разрешена,
// иначе — мигание заголовком вкладки. Notification API требует secure context
// (https/localhost) — на http://<ip> молча падаем в фоллбэк.
// Задел на будущее: тот же интерфейс сможет дёргать Electron-обёртка.

let blinkTimer = null;
let baseTitle = null;

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
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

/**
 * Показать оповещение. tag — дедуп одинаковых (замещает предыдущее с тем же tag).
 */
export function notify(title, body = '', tag = '') {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: tag || undefined, icon: '/favicon.svg' });
      n.onclick = () => { window.focus(); n.close(); };
      return;
    }
  } catch { /* упадём в фоллбэк */ }
  if (document.hidden) titleBlink(title);
}
