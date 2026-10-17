import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('DW-B1: рецепт выпуска только Linux и сохраняет защиту', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../desktop/package.json', import.meta.url), 'utf8'));
  const lockFile = new URL('../../desktop/package-lock.json', import.meta.url);
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));

  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.description, 'Окно Кокпита для компьютера');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(manifest.scripts.dist,
    'npm run build && electron-builder --linux AppImage --x64 --publish never');
  assert.deepEqual(manifest.build.electronFuses, {
    enableCookieEncryption: true,
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
  });
  assert.deepEqual(manifest.build.extraResources, [{ from: 'dist/ui', to: 'ui' }]);
  assert.ok(manifest.build.files.includes('!dist/ui/**/*'));
  assert.equal(manifest.devDependencies.electron, '44.7.0');
  assert.equal(manifest.devDependencies['electron-builder'], '26.15.3');
});

test('DW-B2: в сборке нет старого renderer или preload', async () => {
  const source = await readFile(new URL('../../desktop/scripts/build.mts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /mobile|preload|cockpit-media/u);
  assert.match(source, /entryPoints:\s*\[path\.join\(desktop, 'src\/main\.ts'\)\]/u);
  assert.match(source, /outfile:\s*path\.join\(output, 'main\.cjs'\)/u);
  assert.match(source, /bundle:\s*true/u);
  assert.match(source, /platform:\s*'node'/u);
  assert.match(source, /format:\s*'cjs'/u);
  assert.match(source, /target:\s*'node24'/u);
  assert.match(source, /external:\s*\['electron'\]/u);
  assert.match(source, /copyFile\(path\.join\(desktop, 'build\/window-icon\.png'\),/u);
});

test('SP-07: сборка копирует ресурсы заставки в dist/splash', async () => {
  const source = await readFile(new URL('../../desktop/scripts/build.mts', import.meta.url), 'utf8');

  assert.match(source, /const splashFiles = \['index\.html', 'style\.css', 'illustration\.png'\];/u);
  assert.match(source, /await mkdir\(path\.join\(output, 'splash'\)\);/u);
  assert.match(source, /for \(const name of splashFiles\) \{\s*await copyFile\(/u);
  assert.match(source, /copyFile\(path\.join\(desktop, 'assets\/splash', name\),/u);
  assert.match(source, /,\s*path\.join\(output, 'splash', name\)\);/u);
  assert.ok(source.indexOf("'build/window-icon.png'") < source.indexOf('splashFiles)'),
    'Ресурсы заставки копируются после значка.');
});
