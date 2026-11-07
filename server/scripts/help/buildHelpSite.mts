import path from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from '../../../web/node_modules/vite/dist/node/index.js';
import vue from '../../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import type { HelpBundle } from '../../../shared/help/helpContracts.ts';
import { verifyHelpBundle } from '../../../shared/node/helpSources.ts';

const execute = promisify(execFile);
/**
 * Путь исходного модуля сопоставляется с корнем его npm-пакета только для лицензий.
 * В публичный сайт и payload список путей машины не записывается.
 */
function packageRoot(file: string): string | null {
  const clean = file.split('?', 1)[0] ?? '';
  const marker = '/node_modules/';
  const index = clean.lastIndexOf(marker);

  if (index < 0) {
    return null;
  }

  const prefix = clean.slice(0, index + marker.length);
  const parts = clean.slice(prefix.length).split('/');
  const name = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];

  return name ? prefix + name : null;
}
/**
 * Самостоятельный Vite entry использует общий reader, но не загружает всё приложение.
 * Корпус приходит из сборки сервера и больше не перечитывается из рабочего guide.
 */
export async function buildHelpSite(input: {
  sourceRoot: string;
  output: string;
  bundle: HelpBundle;
}): Promise<string[]> {
  const bundle = verifyHelpBundle(input.bundle);
  const webRoot = path.join(input.sourceRoot, 'web');
  const modules = new Set<string>();

  await execute(process.execPath, [path.join(webRoot, 'scripts/buildMarkdownRenderer.mjs')], {
    cwd: webRoot, maxBuffer: 1024 * 1024,
  });
  await build({
    configFile: false,
    root: path.join(webRoot, 'help'),
    base: './',
    envDir: false,
    publicDir: false,
    plugins: [vue(), {
      name: 'help-license-inputs',
      /**
       * Собирает модули реальных chunks для полного списка лицензий сайта.
       * Локальные пути используются только билдером и не публикуются.
       */
      generateBundle(_options, outputs) {
        for (const output of Object.values(outputs)) {
          if (output.type === 'chunk') {
            for (const id of Object.keys(output.modules)) {
              modules.add(id);
            }
          }
        }
      },
    }],
    build: {
      outDir: input.output,
      emptyOutDir: true,
      sourcemap: false,
      assetsInlineLimit: 0
    },
  });
  await mkdir(input.output, {
    recursive: true
  });
  await writeFile(path.join(input.output, 'help.json'), JSON.stringify(bundle));

  const rendererFile = path.join(webRoot, '.generated/markdown/mermaid-renderer.meta.json');
  const renderer = JSON.parse(await readFile(rendererFile, 'utf8')) as {
    inputs: Record<string, unknown>;
  };

  for (const id of Object.keys(renderer.inputs)) {
    modules.add(path.resolve(webRoot, id));
  }

  const roots = new Set<string>();

  for (const id of modules) {
    const root = packageRoot(id);

    if (root) {
      roots.add(await realpath(root));
    }
  }

  await writeFile(path.join(input.output, 'latest.html'), latestHtml);
  await writeFile(path.join(input.output, 'latest.js'), latestScript);

  return [...roots].sort();
}

export const latestHtml = '<!doctype html><html lang="ru"><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>GrigDesk Help</title><p id="message">GrigDesk Help</p><script src="./latest.js"></script></html>';
export const latestScript = `(() => {
  const english = navigator.language.toLowerCase().startsWith('en');
  const target = document.getElementById('message');
  target.textContent = english ? 'Opening the current guide…' : 'Открываем актуальное руководство…';
  const channel = location.pathname.endsWith('latest-dev.html') ? 'dev' : 'release';
  return fetch('../api/releases/v1/' + channel + '.json', {
    credentials: 'omit', signal: AbortSignal.timeout(10000)
  })
    .then((response) => { if (!response.ok) throw new Error('channel'); return response.json(); })
    .then((index) => {
      const version = index && index.latest && index.latest.payload && index.latest.payload.version;
      const stable = /^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$/;
      if (index.format !== 2 || index.channel !== channel || typeof version !== 'string'
        || !/^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-dev\\.[0-9]+)?$/.test(version)
        || (channel === 'release' && !stable.test(version))) {
        throw new Error('version');
      }
      location.replace('./' + version + '/index.html' + location.hash);
    }).catch(() => {
      target.textContent = english ? 'Could not open the current guide. Try again later.'
        : 'Не удалось открыть актуальное руководство. Повторите позже.';
    });
})();`;
