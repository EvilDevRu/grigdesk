import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

// base './' — чтобы собранная статика работала и на корне сервера, и в поддиректории.
// В dev проксируем API/статику фабрики на сервер кокпита (8140), чтобы фронт ходил
// на тот же origin, что и в проде.
export default defineConfig({
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
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] },
    }),
  ],
  base: './',
  // .env лежит в корне репо (общий для сервера и фронта) — читаем оттуда.
  envDir: '..',
  server: {
    port: 5180,
    proxy: {
      '/api': { target: 'http://localhost:8140', changeOrigin: true, ws: false },
      '/vscode': { target: 'http://localhost:8140', changeOrigin: true, ws: true },
      '/shots': 'http://localhost:8140',
      '/demo': 'http://localhost:8140',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
