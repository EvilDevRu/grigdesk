import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileModule, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';

/**
 * Новый контракт проверяется assertion до компиляции, чтобы отсутствие сервиса давало целевой RED.
 * Все экспорты сценария собираются одним графом и разделяют singleton Vue, Pinia и общую шину.
 */
export async function serviceFixture(t, relative, extras = {}, stubs = {}) {
  const browser = await installUiBrowser(t);
  const filename = webFile(`src/${relative}`);
  const present = await access(filename).then(() => true, () => false);

  assert.equal(present, true, `Не реализован контракт модуля: ${relative}`);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-services-'));
  const entry = path.join(directory, 'entry.ts');
  const lines = [`export * from ${JSON.stringify(filename)};`];

  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const [name, file] of Object.entries(extras)) {
    lines.push(`export * as ${name} from ${JSON.stringify(webFile(`src/${file}`))};`);
  }

  lines.push(`export * as vue from 'vue';`);
  lines.push(`export * as pinia from 'pinia';`);
  lines.push(`export * as ui from ${JSON.stringify(webFile('src/ui.ts'))};`);
  await writeFile(entry, lines.join('\n'));

  return { ...await compileModule(entry, { stubs }), browser };
}
