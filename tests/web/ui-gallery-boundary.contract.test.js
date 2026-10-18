import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkUiGalleryBoundary,
} from '../../web/scripts/check-ui-gallery-boundary.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');

function fixtureRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-ui-gallery-'));

  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true,
  }));

  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }

  return root;
}

test('UI gallery остаётся отдельным dev entry без product dependencies', () => {
  assert.deepEqual(checkUiGalleryBoundary({ repoRoot: REPO_ROOT }).errors, []);
});

test('UI gallery guard ловит private import, production link и dist artifact', (t) => {
  const root = fixtureRepo(t, {
    'web/dev/ui-gallery/main.ts': "import '../../src/stores/auth.js';",
    'web/src/App.vue': '<script setup>const marker = "dev/ui-gallery";</script>',
    'web/ui-gallery.html': '<script type="module" src="/dev/ui-gallery/main.ts"></script>',
    'web/dist/assets/ui-gallery.js': 'GrigDesk UI Gallery',
  });
  const errors = checkUiGalleryBoundary({ repoRoot: root }).errors.join('\n');

  assert.match(errors, /gallery import вне public\/dev boundary/u);
  assert.match(errors, /production\/private dependency/u);
  assert.match(errors, /production source подключает gallery/u);
  assert.match(errors, /gallery artifact попал в dist/u);
});
