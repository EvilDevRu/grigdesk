import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const version = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;

export default defineConfig({
  plugins: [vue()],
  base: './',
  server: { watch: { ignored: ['**/android/**'] } },
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
  build: { outDir: 'dist' },
});
