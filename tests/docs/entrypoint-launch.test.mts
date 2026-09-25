import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { entrypointsWithTypeScript, ENTRYPOINTS } from '../../tools/entrypointGraph.mts';

const REPO = new URL('../../', import.meta.url);

// Флаг снятия типов больше не нужен нигде: минимум Node 22.18 исполняет TypeScript
// сам. Оставленная строка — не безобидная, а обещание поддерживать рантайм, на котором
// проект уже не проверяется, и лишний слой в каждом spawn и юните.
const FORBIDDEN_FLAG = /--experimental-strip-types/;

// Гашение предупреждения об экспериментальном `node:sqlite` — ДРУГОЕ обязательство. Его
// единственный потребитель, хранилище базы знаний, снят вместе с ней, поэтому флаг сейчас
// не разрешён нигде: новый потребитель вносит себя сюда вместе с обоснованием.
const SQLITE_WARNING_FLAG = /--disable-warning=ExperimentalWarning/;
const SQLITE_WARNING_ALLOWED = new Set<string>();

// Где действительно запускают собственные программы: лаунчеры, юнит, установщик,
// команды пакетов и общий прогон. Приватные каталоги и сборку сюда не включаем.
const LAUNCH_FILES = [
  'bin/cockpit',
  'bin/launch',
  'bin/restart',
  'bin/lib/runtime-env.sh',
  'deploy/install.sh',
  'deploy/shortcut.sh',
  'deploy/cockpit-server.service',
  'server/package.json',
  'web/package.json',
  'tests/run-all.sh',
];

async function source(path: string): Promise<string> {
  return readFile(new URL(path, REPO), 'utf8');
}

/**
 * Рубеж минимума Node. Проверка перевёрнута относительно прежней: раньше требовалось
 * передать флаг каждому запуску, теперь — не передавать его нигде. Одна забытая
 * строка вернула бы обвязку по частям, а вместе с ней и вопрос «какая версия нужна».
 */
test('ни один запуск в репозитории не передаёт флаг снятия типов', async () => {
  const stripping: string[] = [];
  const warning: string[] = [];

  for (const path of LAUNCH_FILES) {
    const text = await source(path);

    if (FORBIDDEN_FLAG.test(text)) {
      stripping.push(path);
    }
    if (SQLITE_WARNING_FLAG.test(text) && !SQLITE_WARNING_ALLOWED.has(path)) {
      warning.push(path);
    }
  }

  assert.deepEqual({ stripping, warning }, { stripping: [], warning: [] });
});

test('минимум Node объявлен и проверяется на запуске', async () => {
  const [serverPkg, webPkg, runtimeEnv, gate] = await Promise.all([
    source('server/package.json'),
    source('web/package.json'),
    source('bin/lib/runtime-env.sh'),
    source('server/src/lib/nodeVersion.ts'),
  ]);

  assert.equal(JSON.parse(serverPkg).engines.node, '>=22.18.0');
  assert.equal(JSON.parse(webPkg).engines.node, '>=22.18.0');
  // Отказ должен наступать до запуска: иначе человек получит ошибку разрешения
  // модуля `.ts` вместо ответа «нужен Node новее».
  assert.match(runtimeEnv, /COCKPIT_MIN_NODE=22\.18\.0/);
  assert.match(runtimeEnv, /cockpit_require_node\s*\(\)/);
  assert.match(gate, /MIN_NODE_VERSION = '22\.18\.0'/);
  assert.match(await source('server/src/app.ts'), /assertSupportedNode\(\)/);

  // Лаунчер юнита проверяет версию САМ и на голом JavaScript: до `import('./app.ts')`
  // общий гейт недостижим — он тоже `.ts`, и на старом Node упал бы на разрешении модуля.
  const launcher = await source('server/src/app.js');

  assert.match(launcher, /MIN_NODE_VERSION = '22\.18\.0'/);
  assert.match(launcher, /process\.versions\.node/);
  assert.doesNotMatch(
    launcher.split("await import('./app.ts')")[0] ?? '',
    /^import\s/mu,
    'до проверки версии в лаунчере не должно быть статических импортов',
  );
});

test('все объявленные точки входа существуют, а их граф известен', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const missing = ENTRYPOINTS.filter((path) => (
    !existsSync(fileURLToPath(new URL(path, REPO)))
  ));

  assert.deepEqual(missing, []);
  // Хотя бы часть входов доходит до TypeScript: пустой список означал бы, что обход
  // графа сломался и проверка перестала что-либо доказывать.
  assert.ok(entrypointsWithTypeScript().length > 0);
});
