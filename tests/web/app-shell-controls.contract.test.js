import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const APP_SHELL_PATH = new URL('../../web/src/shared/layout/AppShell.vue', import.meta.url);
const PROVIDER_USAGE_PATH = new URL(
  '../../web/src/features/providers/ProviderUsageResources.vue',
  import.meta.url,
);
const ACTIONS_PATH = new URL('../../web/src/styles/components/actions.css', import.meta.url);

test('AppShell использует public UI controls и DOM handle триггера инструментов', async () => {
  const [source, providerUsage, actions] = await Promise.all([
    readFile(APP_SHELL_PATH, 'utf8'),
    readFile(PROVIDER_USAGE_PATH, 'utf8'),
    readFile(ACTIONS_PATH, 'utf8'),
  ]);
  const publicUiImport = source.match(/import\s*\{([^}]*)\}\s*from '\.\.\/\.\.\/ui';/u);

  assert.ok(publicUiImport);
  assert.match(publicUiImport[1], /\bUiButton\b/u);
  assert.match(publicUiImport[1], /\bUiPressable\b/u);
  assert.equal([...source.matchAll(/<UiPressable\b/gu)].length, 4);
  assert.equal([...source.matchAll(/<UiButton\b/gu)].length, 5);
  assert.doesNotMatch(source, /<button\b/u);
  assert.match(source, /toolsTrigger\.value\?\.el\?\.getBoundingClientRect/u);
  assert.match(source, /toolsTrigger\.value\?\.el\?\.contains/u);
  assert.doesNotMatch(source, /\.pu-state button|\.ptip-go button|\.instbar button/u);
  assert.match(source, /data-context="topbar-popover-action"/u);
  assert.match(source, /data-context="topbar-popover-footer"/u);
  assert.match(providerUsage, /data-context="topbar-popover-confirm"/u);
  assert.match(providerUsage, /data-context="topbar-popover-resource-link"/u);
  assert.match(
    actions,
    /data-context='topbar-popover-action'\][^{]*\{[^}]*height:\s*28px;/u,
  );
  assert.match(
    actions,
    /data-context='topbar-popover-footer'\][^{]*\{[^}]*height:\s*30px;/u,
  );
  assert.match(
    actions,
    /data-context='topbar-popover-resource-link'\][^{]*\{[^}]*height:\s*auto;/u,
  );
  assert.match(
    actions,
    /data-context='topbar-popover-resource-link'\][^{]*\{[^}]*white-space:\s*normal;/u,
  );
});
