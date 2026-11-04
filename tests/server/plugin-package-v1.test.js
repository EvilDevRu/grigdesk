import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { validatePluginPackage } from '../../server/src/lib/packageInstall/validatePackage.ts';
import { scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import { expectedPackage, manifestV1, packageV1, png } from '../helpers/pluginV1.js';

test('V1-PACKAGE: declared server/module и обязательное описание проходят настоящий validator', async (t) => {
  const f = await packageV1(t);
  const result = await validatePluginPackage(f.dir, expectedPackage);

  assert.equal(result.hasServer, true);
  assert.equal(result.webModuleDir, 'ui');
  assert.equal(result.description, f.manifest.description);
  assert.equal('webDir' in result, false);
});

for (const [label, overrides, files] of [
  ['пустое описание', { description: '' }, {}],
  ['нет icon', { icon: undefined }, {}],
  ['SVG', { icon: 'assets/icon.svg' }, { 'assets/icon.svg': '<svg/>' }],
  ['SVG под видом PNG', {}, { 'assets/icon.png': '<svg/>' }],
  ['icon size+1', {}, { 'assets/icon.png': Buffer.concat([png, Buffer.alloc(256 * 1024 + 1)]) }],
  ['7 screenshots', { gallery: { screenshots: Array.from({ length: 7 }, (_, i) => `assets/${i}.png`) } },
    Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`assets/${i}.png`, png]))],
  ['screenshot size+1', { gallery: { screenshots: ['assets/large.png'] } },
    { 'assets/large.png': Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024 + 1)]) }],
  ['дубликат screenshot', { gallery: { screenshots: ['assets/icon.png', 'assets/icon.png'] } }, {}],
]) {
  test(`V1-PACKAGE-REFUSAL: ${label}, scanner и installer объясняют один отказ`, async (t) => {
    const f = await packageV1(t, manifestV1(overrides), files);
    let failure;

    await assert.rejects(validatePluginPackage(f.dir, expectedPackage), (error) => {
      failure = error;

      return typeof error.code === 'string' && !error.message.includes(f.dir);
    });

    const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

    assert.equal(card?.compatibility?.status, 'incompatible');
    assert.equal(card.compatibility.code, failure.code);
    assert.ok(card.compatibility.reason);
  });
}

test('V1-PACKAGE-REFUSAL: ссылка на icon не читается scanner и installer', async (t) => {
  const f = await packageV1(t);
  const outside = path.join(f.root, 'outside.png');

  await writeFile(outside, png);
  await rm(path.join(f.dir, 'assets/icon.png'));
  await symlink(outside, path.join(f.dir, 'assets/icon.png'));
  await assert.rejects(validatePluginPackage(f.dir, expectedPackage), { code: 'symlink_forbidden' });

  const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

  assert.equal(card?.compatibility?.status, 'incompatible');
  assert.ok(card.compatibility.reason);
});

test('V1-PACKAGE: ровные лимиты icon 256KiB и 6 screenshot по 4MiB принимаются', async (t) => {
  const screenshots = Array.from({ length: 6 }, (_, i) => `assets/${i}.png`);
  const f = await packageV1(t, manifestV1({ gallery: { screenshots } }), {
    'assets/icon.png': Buffer.concat([png, Buffer.alloc(256 * 1024 - png.length)]),
    ...Object.fromEntries(screenshots.map((file) => [
      file, Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024 - png.length)]),
    ])),
  });
  const result = await validatePluginPackage(f.dir, expectedPackage);
  const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

  assert.equal(result.hasServer, true);
  assert.equal(card?.compatibility?.status, 'compatible');
});

for (const [extension, encoded] of [
  ['jpg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIx'
    + 'wcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy'
    + 'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAw'
    + 'QFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK'
    + 'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmq'
    + 'KjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEB'
    + 'AQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRob'
    + 'HBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE'
    + 'hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+P'
    + 'n6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z'],
  ['webp', 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAA'
    + 'A='],
]) {
  test(`V1-PACKAGE: настоящий ${extension} допускается для icon и screenshots`, async (t) => {
    const icon = `assets/icon.${extension}`;
    const f = await packageV1(t, manifestV1({ icon, gallery: { screenshots: [icon] } }), {
      [icon]: Buffer.from(encoded, 'base64'),
    });
    const validated = await validatePluginPackage(f.dir, expectedPackage);
    const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

    assert.equal(validated.hasServer, true);
    assert.equal(card?.compatibility?.status, 'compatible');
  });
}
