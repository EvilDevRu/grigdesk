// Отдельный classic script работает в opaque iframe без ESM CORS и без внешних imports.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(webRoot, '.generated/markdown');

await mkdir(directory, { recursive: true });

const result = await build({
  entryPoints: [path.join(webRoot, 'src/shared/markdown/mermaidSandboxEntry.ts')],
  outfile: path.join(directory, 'mermaid-renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  splitting: false,
  minify: true,
  metafile: true,
  logLevel: 'warning',
});
const externalImports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);

if (externalImports.length) {
  throw new Error('Renderer Mermaid содержит внешние импорты');
}

await writeFile(path.join(directory, 'mermaid-renderer.meta.json'),
  JSON.stringify(result.metafile, null, 2));
console.log('Renderer Mermaid собран без внешних импортов');
