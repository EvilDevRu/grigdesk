import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

const envDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function buildMetadata() {
  let version = process.env.VITE_COCKPIT_VERSION || 'dev';
  let sha = process.env.VITE_COCKPIT_SHA || 'dev';
  try { if (version === 'dev') version = readFileSync(path.join(envDir, 'VERSION'), 'utf8').trim(); }
  catch { /* dev checkout без VERSION */ }
  try {
    if (sha === 'dev') sha = execFileSync('git', ['-C', envDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* source archive может собираться без .git; worker передаёт SHA через env */ }
  return { version, sha };
}

// base './' — чтобы собранная статика работала и на корне сервера, и в поддиректории.
// В dev проксируем API/статику фабрики на настроенный порт сервера, чтобы фронт ходил
// на тот же origin, что и в проде.
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, envDir, '');
  // loadEnv не меняет process.env. Явно сохраняем тот же приоритет, что у `node --env-file`:
  // уже экспортированная переменная выше значения из корневого .env.
  const cockpitPort = Number(process.env.COCKPIT_PORT ?? fileEnv.COCKPIT_PORT) || 8140;
  const proxyTarget = `http://localhost:${cockpitPort}`;
  const metadata = buildMetadata();

  return {
    plugins: [
      vue(),
      // PWA: устанавливается на планшет, обновляется через баннер (registerType 'prompt').
      VitePWA({
        registerType: 'prompt',
        manifest: {
          name: 'Кокпит',
          short_name: 'Кокпит',
          description: 'Пульт: доска B24, конвейер фабрики, стенды',
          theme_color: '#0b0d11',
          background_color: '#0b0d11',
          display: 'standalone',
          lang: 'ru',
          start_url: './',
          // Без иконок 192 и 512 Chrome НЕ предложит установку — приложение останется закладкой
          // в браузере вместо WebAPK со своей иконкой и без адресной строки.
          // Пути относительные (не с `/`) — резолвятся от манифеста, живут и в поддиректории.
          // Генерируются `python3 scripts/gen-icons.py` → public/.
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            // maskable — Android режет иконку под форму лончера (круг/сквиркл); рисунок
            // вписан в safe zone, иначе рамку обрежет по краям.
            { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Обработчик клика по системному уведомлению отдельным файлом: generated SW
          // остаётся под управлением Workbox, а PWA фокусируется/открывается по нажатию.
          importScripts: ['notification-sw.js'],
          // Monaco (диф-редактор) — крупный чанк; поднимаем лимит прекеша (по умолчанию 2 МБ).
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          // SPA-fallback не должен перехватывать API/статику.
          navigateFallbackDenylist: [/^\/api/, /^\/shots/],
        },
      }),
    ],
    base: './',
    define: {
      __COCKPIT_VERSION__: JSON.stringify(metadata.version),
      __COCKPIT_SHA__: JSON.stringify(metadata.sha),
    },
    // .env лежит в корне репо (общий для сервера и фронта) — читаем оттуда.
    envDir,
    server: {
      port: 5180,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true, ws: false },
        '/vscode': { target: proxyTarget, changeOrigin: true, ws: true },
        '/shots': proxyTarget,
      },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
