import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('./src/panel.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'panel.js',
      cssFileName: 'panel',
    },
    rollupOptions: {
      external: ['vue', '@grigdesk/ui'],
    },
  },
});
