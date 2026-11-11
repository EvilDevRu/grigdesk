import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const forbidden = [
  new RegExp(
    String.raw`(?:\b(?:rootDir|root|ROOT|repositoryRoot|repoRoot|REPO_ROOT|codeRoot|projectRoot|`
    + String.raw`grigDeskRoot|PROJECT_ROOT|here)|import\.meta\.dirname|__d`
    + String.raw`irname(?:\s*,\s*'\.\.')*)\s*,\s*'(?:\.state(?:\/(?!android-|npm-|mobile-d`
    + String.raw`ownloads)[^']*)?|chats|telegram|github|3d|agents|plugins|\.env)'`,
  ),
  /['"`][^'"`\n]*server\/\.state[^'"`\n]*['"`]|'server',\s*'\.state'/,
  /'(?:\.\.\/)+(?:\.state|\.env|chats|telegram|github|3d|agents|plugins)\b/,
  new RegExp(
    String.raw`\$\{?(?:ROOT|_root|GRIGDESK_DIR|DIR|root|grigdesk_root|MOBILE_ROOT)\}?\/(?:server\/\.st`
    + String.raw`ate|\.env\b|\.state\/(?:plugins|ui-releases|mobile|artifacts)(?=[/"'}\s]|$))`,
  ),
  /__GRIGDESK_DIR__\/\.env/,
];

// Исключения узкие: имя файла и фрагмент строки, а не отключение проверки целого слоя.
// Каждое старое место должно объясняться переносом, защитой или переходным чтением.
const exceptions: Array<[string, string, string]> = [
  ['server/src/lib/kimi/sandbox.ts', 'const legacyState =', 'Защита настоящей старой раскладки.'],
  ['server/src/lib/kimi/sandbox.ts', 'const legacyEnv =', 'Защита настоящей старой раскладки.'],
  ['server/src/lib/dataHomeBoot.ts', 'server/.state', 'Сторож прежней раскладки.'],
  ['server/src/lib/dataHomeBoot.ts', "codeRoot, '.env'", 'Сторож прежнего файла настроек.'],
  ['cli/commands.ts', 'server/.state', 'Переходное чтение до ручного переноса.'],
  ['cli/commands.ts', "root, '.env'", 'Переходное чтение до ручного переноса.'],
  ['server/src/lib/grigDeskUpdate.ts', "'--work-root'", 'Рабочая копия обновления на диске кода.'],
  ['server/scripts/glmLiveSmoke.mts', "chatsDir: path.join(root, 'chats')", 'Временная тестовая область.'],
];

// Обходим только перечисленные кодовые каталоги; хранилища пользователя сюда не входят.
// Рекурсивный обход нужен серверному исходнику, исходнику tracker и shell-библиотекам deploy.
function codeFiles(directory: string, extensions: RegExp, recursive = false, base = root): string[] {
  const result: string[] = [];

  for (const entry of readdirSync(path.join(base, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;

    if (entry.isDirectory() && recursive) {
      result.push(...codeFiles(file, extensions, true, base));
    } else if (entry.isFile() && extensions.test(entry.name)) {
      result.push(file);
    }
  }

  return result;
}

/**
 * Находки сторожа путей для заданного корня и списка файлов.
 * DP-1 и негативная фикстура BD-02 проверяют одно и то же правило.
 */
function pathFindings(base: string, files: readonly string[]): string[] {
  const findings: string[] = [];

  for (const file of files) {
    const lines = readFileSync(path.join(base, file), 'utf8').split('\n');

    // «#» — комментарий только в shell и юните; в TS с него начинаются приватные члены класса.
    const shell = /\.(?:sh|service)$/.test(file) || ['bin/grigdesk-ctl', 'tools/mobile',
      'tools/relay'].includes(file);
    const comment = shell ? /^\s*#/ : /^\s*(?:\/\/|\*)/;

    lines.forEach((source, index) => {
      // Спецификаторы импорта — код, а не данные: `../telegram/…` и `../../plugins/auth.ts`.
      const line = source.replace(/\bfrom\s*['"][^'"]*['"]|\bimport\s*\(\s*['"][^'"]*['"]\s*\)/g, '');

      if (comment.test(line) || !forbidden.some((pattern) => pattern.test(line))) {
        return;
      }

      const allowed = exceptions.some(([name, fragment, reason]) =>
        name === file && line.includes(fragment) && reason);

      if (!allowed) {
        findings.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  return findings;
}

test('DP-1 данные не вычисляются от дерева кода', () => {
  const files = [
    ...codeFiles('server/src', /\.(?:ts|js|mjs)$/, true),
    ...codeFiles('server/scripts', /\.(?:mts|mjs)$/),
    ...['cli', 'shared', 'desktop/src'].flatMap((dir) => codeFiles(dir, /\.ts$/, dir === 'shared')),
    ...codeFiles('tracker/src', /\.ts$/, true),
    ...codeFiles('deploy', /\.sh$/, true),
    ...codeFiles('tools', /\.(?:ts|mts|mjs)$/),
    ...codeFiles('tools/mobile-phone', /\.mts$/),
    ...codeFiles('web/scripts', /\.(?:mjs|mts)$/),
    ...codeFiles('desktop/scripts', /\.mts$/),
    'deploy/grigdesk-server.service', 'bin/grigdesk-ctl', 'tools/mobile', 'tools/relay',
    'web/vite.config.js',
  ];
  const findings = pathFindings(root, files);

  assert.deepEqual(findings, [], findings.join('\n'));
});

test('BD-02: исходники tracker покрыты сторожем путей, бинарник не читается как текст', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'tracker-data-paths-'));

  mkdirSync(path.join(fixture, 'tracker/src/nested'), { recursive: true });
  mkdirSync(path.join(fixture, 'bin'));
  writeFileSync(path.join(fixture, 'tracker/src/nested/legacy.ts'),
    "const token = path.join(root, '.env');\n");
  writeFileSync(path.join(fixture, 'tracker/src/clean.ts'), "const token = dataPath(home, 'cliToken');\n");
  writeFileSync(path.join(fixture, 'bin/tracker'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0xfe, 0x00]));

  const files = codeFiles('tracker/src', /\.ts$/, true, fixture);

  assert.deepEqual(files.sort(), ['tracker/src/clean.ts', 'tracker/src/nested/legacy.ts']);
  assert.deepEqual(pathFindings(fixture, files), [
    "tracker/src/nested/legacy.ts:1: const token = path.join(root, '.env');",
  ]);
});

test('DP-2 gitignore скрывает также ссылку на состояние', () => {
  assert.ok(readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').includes('/server/.state'));
});

test('DP-3 Vite выбирает общий файл окружения', () => {
  assert.match(readFileSync(path.join(root, 'web/vite.config.js'), 'utf8'), /envFilePath\(/);
});
