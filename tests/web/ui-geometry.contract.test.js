import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PACKAGE_PATH = new URL('../../web/package.json', import.meta.url);
const SCRIPT_PATH = new URL('../../web/scripts/check-ui-geometry.mjs', import.meta.url);
const GALLERY_PATH = new URL('../../web/dev/ui-gallery/UiGallery.vue', import.meta.url);

test('Chrome geometry matrix закрепляет viewports и overlay/disclosure fixtures', async () => {
  const [packageSource, script, gallery] = await Promise.all([
    readFile(PACKAGE_PATH, 'utf8'),
    readFile(SCRIPT_PATH, 'utf8'),
    readFile(GALLERY_PATH, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts['test:ui-browser'], 'node scripts/check-ui-geometry.mjs');
  assert.match(script, /\[340, 360, 600, 759, 760, 899, 900, 1200, 1500\]/u);
  assert.match(script, /process\.env\.CHROME_BIN/u);
  assert.match(script, /data-geometry-disclosure/u);
  assert.match(script, /data-geometry-popover-trigger/u);
  assert.match(script, /data-geometry-dialog-trigger/u);
  assert.match(script, /data-geometry-composer-input/u);
  assert.match(script, /data-geometry-context-ring/u);
  assert.match(script, /data-geometry-dock-action/u);
  assert.match(script, /data-geometry-chat-list-button/u);
  assert.match(script, /data-geometry-task-footer-action/u);
  assert.match(script, /data-geometry-topbar-action/u);
  assert.match(script, /data-geometry-provider-link/u);
  assert.match(script, /data-geometry-provider-switch/u);
  assert.match(gallery, /data-geometry-loading="idle"/u);
  assert.match(gallery, /data-geometry-disclosure/u);
  assert.match(gallery, /data-geometry-dialog/u);
  assert.match(gallery, /data-geometry-composer/u);
  assert.match(gallery, /data-geometry-context-ring/u);
  assert.match(gallery, /data-geometry-dock-actions/u);
  assert.match(gallery, /data-geometry-chat-list-button/u);
  assert.match(gallery, /data-geometry-task-footer-action/u);
  assert.match(gallery, /data-geometry-topbar-footer/u);
  assert.match(gallery, /data-geometry-provider-popover/u);
  assert.match(gallery, /data-geometry-provider-link/u);
  assert.match(gallery, /data-geometry-provider-switch/u);
});
