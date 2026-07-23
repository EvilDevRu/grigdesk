// Единая конфигурация сервера кокпита.
// Всё, что зависит от машины/окружения, — только здесь (задел «сменный мозг»).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

export const config = {
  // Сеть. HOST=0.0.0.0 — чтобы окно (планшет) достучалось через Tailscale.
  port: Number(process.env.COCKPIT_PORT) || 8140,
  host: process.env.COCKPIT_HOST || '0.0.0.0',

  // Пути «мозга».
  stateDir: process.env.FACTORY_STATE_DIR || path.join(home, '.factory', 'state'),
  factoryHome: process.env.FACTORY_HOME || path.join(home, 'Workspace', 'factory'),

  // Собранный фронт (по умолчанию отдаём тем же сервером — один origin).
  webDist: process.env.COCKPIT_WEB_DIST || path.join(__dirname, '..', '..', 'web', 'dist'),

  // Токен на мутации (POST/PUT/DELETE). Пусто → мутации открыты внутри доверенной сети
  // (Tailscale). Для боевого доступа задать COCKPIT_TOKEN.
  mutateToken: process.env.COCKPIT_TOKEN || '',

  // Битрикс24. Куки и креды — В СВОЁМ каталоге (изоляция: свой cookie-файл = нет
  // session-thrash). Портал/креды задаются из «Настроек» и живут в .state (gitignore).
  // Никаких проектных значений по умолчанию в коде — пустой кокпит не знает ничего.
  b24BaseUrl: process.env.COCKPIT_B24_BASE_URL || '',
  b24CookiePath: process.env.B24_COOKIE_PATH || path.join(__dirname, '..', '.state', 'b24-cookies.json'),
  b24CredsPath: process.env.B24_CREDS_PATH || path.join(__dirname, '..', '.state', 'b24-creds.json'),

  // Команда сноса стенда (проектно-специфична) — задаётся окружением, {task} подставляется.
  // Пусто → кнопка «снести стенд» отвечает «не настроено». Без хардкода путей проекта.
  sandboxDownCmd: process.env.COCKPIT_SANDBOX_DOWN_CMD || '',

  // Медиа-конвейер (распознавание речи). Python venv — через COCKPIT_MEDIA_PYTHON
  // (venv тяжёлый, переиспользуем; читается в media/preflight.js). Хранилище job'ов/медиа.
  mediaDir: process.env.COCKPIT_MEDIA_DIR || path.join(__dirname, '..', '.state', 'media'),
  mediaPython: process.env.COCKPIT_MEDIA_PYTHON || '',

  // Режим.
  isDev: process.env.NODE_ENV === 'development',
};
