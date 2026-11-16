import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';


const root = fileURLToPath(new URL('../../', import.meta.url));
const brand = 'docs/images/brand';
const android = 'mobile/android/app/src/main/res';
const masters = ['wordmark', 'wordmark-reversed', 'stacked', 'gd', 'gd-reversed', 'gd-small',
  'g-small', 'g-small-reversed', 'favicon-tile', 'app-icon', 'wordmark-light', 'wordmark-graphite'];
const densities = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};
const files = [
  ...masters.map((name) => `${brand}/grigdesk-${name}.svg`),
  `${brand}/grigdesk-app-icon-1024.png`, `${brand}/grigdesk-maskable-512.png`,
  'desktop/build/icon.png', 'desktop/build/window-icon.png', 'bin/grigdesk.png',
  'web/public/icon-96.png',
  ...['web', 'mobile'].flatMap((area) => ['192', '512', 'maskable-512']
    .map((size) => `${area}/public/icon-${size}.png`)),
  ...Object.keys(densities).flatMap((density) => ['', '_round']
    .map((suffix) => `${android}/mipmap-${density}/ic_launcher${suffix}.png`)),
  `${android}/drawable/ic_launcher_foreground.xml`, `${android}/values/ic_launcher_background.xml`,
  'web/src/shared/notificationIcon.ts', 'web/index.html',
  'web/src/shared/GrigDeskMark.vue', 'mobile/src/ui/UiBrandMark.vue',
  'mobile/android/client/src/main/res/drawable-nodpi/client_icon.png',
  'mobile/android/client/src/main/res/drawable/ic_launcher_foreground.xml',
  'mobile/android/client/src/main/res/values/ic_launcher_background.xml',
  'mobile/android/client/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
  'mobile/android/client/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
];

function read(file: string): Buffer {
  assert.ok(existsSync(path.join(root, file)), `Отсутствует ${file}`);

  return readFileSync(path.join(root, file));
}

function text(file: string): string {
  return read(file).toString('utf8');
}

function paths(file: string): string[] {
  return [...text(file).matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]!);
}

/**
 * Сравнивает только существующие файлы, поэтому работает и до смены набора мастеров.
 * Каталог векторов включён целиком: генератор не должен создавать лишние старые имена.
 */
function hashes(): Record<string, string> {
  const candidates = new Set([
    ...files,
    ...readdirSync(path.join(root, brand)).map((name) => `${brand}/${name}`),
  ]);

  return Object.fromEntries([...candidates].filter((file) => existsSync(path.join(root, file))).sort()
    .map((file) => [file, createHash('sha256').update(read(file)).digest('hex')]));
}

/**
 * Получает пути компонента из литералов TypeScript без запуска Vue или браузера.
 * Склеенные строки допускают читаемое хранение длинного SVG-контура в исходнике.
 */
function componentPaths(file: string): string[] {
  const source = text(file);
  const literal = /const (?:PART_\d+) = ([\s\S]*?);/g;

  return [...source.matchAll(literal)].map((match) =>
    [...match[1]!.matchAll(/'([^']*)'/g)].map((part) => part[1]).join(''));
}

test('GI-01: в продукте только утверждённые мастера нового знака', () => {
  const expected = [...masters.map((name) => `grigdesk-${name}.svg`),
    'grigdesk-app-icon-1024.png', 'grigdesk-maskable-512.png'].sort();
  const actual = readdirSync(path.join(root, brand)).sort();

  assert.deepEqual(actual, expected);
  assert.ok(actual.every((name) => !name.startsWith('cockpit-')));

  for (const name of masters) {
    assert.doesNotMatch(text(`${brand}/grigdesk-${name}.svg`), /M202\.31 42\.24A106|Шкала C/);
  }
});

test('GI-02: все растры имеют утверждённые размеры', () => {
  const sizes: Array<[string, number]> = [
    ['desktop/build/icon.png', 512], ['desktop/build/window-icon.png', 64],
    ['web/public/icon-96.png', 96], ['bin/grigdesk.png', 512],
    ...['web', 'mobile'].flatMap((area): Array<[string, number]> => [
      [`${area}/public/icon-192.png`, 192], [`${area}/public/icon-512.png`, 512],
      [`${area}/public/icon-maskable-512.png`, 512],
    ]),
    ...Object.entries(densities).flatMap(([density, size]): Array<[string, number]> =>
      ['', '_round'].map((suffix) => [`${android}/mipmap-${density}/ic_launcher${suffix}.png`, size])),
  ];

  for (const [file, size] of sizes) {
    const bytes = read(file);

    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', file);
    assert.equal(bytes.readUInt32BE(16), size, file);
    assert.equal(bytes.readUInt32BE(20), size, file);
  }
});

test('GI-03: значок команды побайтно равен значку веба', () => {
  assert.ok(read('bin/grigdesk.png').equals(read('web/public/icon-512.png')));
});

test('GI-04: встроенные favicon и уведомление равны мастерам', () => {
  const source = text('web/src/shared/notificationIcon.ts');
  const declaration = source.match(/export const NOTIFICATION_ICON = ([\s\S]*);/)?.[1];

  assert.ok(declaration);

  const url = [...declaration.matchAll(/'([^']*)'/g)].map((match) => match[1]).join('');

  assert.ok(url.startsWith('data:image/png;base64,'));
  assert.ok(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
    .equals(read('web/public/icon-96.png')));

  const href = text('web/index.html').match(/rel="icon" href="([^"]+)"/)?.[1];

  assert.ok(href);
  assert.ok(href.startsWith('data:image/svg+xml,'));
  assert.equal(decodeURIComponent(href.slice('data:image/svg+xml,'.length)),
    text(`${brand}/grigdesk-favicon-tile.svg`));
});

test('GI-05: шапка и Android сохраняют полный L8 и исходную G', () => {
  const master = `${brand}/grigdesk-app-icon.svg`;
  const contours = paths(master);
  const originalG = paths(`${brand}/grigdesk-wordmark.svg`)[0]!.split('M371.83')[0];

  assert.equal(contours.length, 3);
  assert.equal(contours[2], originalG);

  for (const file of ['web/src/shared/GrigDeskMark.vue', 'mobile/src/ui/UiBrandMark.vue']) {
    assert.deepEqual(componentPaths(file), contours, file);
    assert.match(text(file), /translate\(24 12\)/);
    assert.match(text(file), /translate\(35.264 54.763\) scale\(0.51\)/);

    for (const color of ['#9A7DF5', '#292C46', '#FFFFFF']) {
      assert.ok(text(file).includes(`fill="${color}"`));
    }
  }

  const client = 'mobile/android/client/src/main';
  const foreground = text(`${android}/drawable/ic_launcher_foreground.xml`);

  assert.deepEqual([...foreground.matchAll(/android:pathData="([^"]+)"/g)].map((match) => match[1]),
    contours);
  assert.match(foreground, /android:scaleX="0.20"/);
  assert.match(foreground, /android:translateX="28.4"/);
  assert.match(foreground, /android:scaleX="0.51"/);
  assert.equal(text(`${client}/res/drawable/ic_launcher_foreground.xml`), foreground);
  assert.ok(read(`${client}/res/drawable-nodpi/client_icon.png`).equals(read('web/public/icon-512.png')));
  assert.match(text(`${client}/AndroidManifest.xml`), /android:icon="@mipmap\/ic_launcher"/);
  assert.match(text(`${client}/AndroidManifest.xml`), /android:roundIcon="@mipmap\/ic_launcher_round"/);

  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    assert.match(text(`${client}/res/mipmap-anydpi-v26/${name}.xml`),
      /@drawable\/ic_launcher_foreground/);
  }

  assert.match(text(`${android}/values/ic_launcher_background.xml`), /#0B0D11/);
  assert.match(text('web/src/shared/layout/AppShell.vue'),
    /\.app-mark \.logo \{ width: 20px; height: 20px;/);
});

test('GI-06: повтор генератора не меняет байты ни одного результата', () => {
  const before = hashes();
  const result = spawnSync('python3', ['-I', 'web/scripts/gen-icons.py'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(hashes(), before);
});
