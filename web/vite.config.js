import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { envFilePath } from '../shared/runtime/dataHome.ts';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import pluginRuntimePlugin from './scripts/pluginRuntimePlugin.mjs';
import localApiPlugin from './scripts/localApiPlugin.ts';

const envDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Номер выпуска приходит из единого build input, локальная сборка читает VERSION.
 * Git identity остаётся отдельной подписью интерфейса и не заменяет продуктовый номер.
 */
function buildMetadata() {
  let version = process.env.GRIGDESK_RELEASE_VERSION || process.env.VITE_GRIGDESK_VERSION || 'dev';
  let sha = process.env.VITE_GRIGDESK_SHA || 'dev';
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
export default defineConfig(({ command }) => {
  let fileEnv = {};

  if (command === 'serve') {
    try {
      const file = envFilePath({ env: process.env, home: os.homedir() });

      fileEnv = parseEnv(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const effectiveEnv = { ...fileEnv, ...process.env };
  const grigDeskPort = Number(effectiveEnv.GRIGDESK_PORT) || 8140;
  const metadata = buildMetadata();

  return {
    plugins: [vue(), pluginRuntimePlugin(), localApiPlugin({ port: grigDeskPort, env: effectiveEnv })],
    base: './',
    define: {
      __GRIGDESK_VERSION__: JSON.stringify(metadata.version),
      __GRIGDESK_SHA__: JSON.stringify(metadata.sha),
    },
    // envDir — корень репозитория (VERSION, git, VITE_*); .env GrigDesk лежит в папке данных.
    envDir,
    server: {
      host: '127.0.0.1',
      port: 5180,
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
