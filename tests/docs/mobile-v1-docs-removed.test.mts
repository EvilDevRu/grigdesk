import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('DOCS-V1: документы v1 удалены, README без раздела совместимости, checks сохранён', async () => {
  for (const rel of [
    'docs/grigdesk/mobile/architecture.md',
    'docs/grigdesk/mobile/chat-controls.md',
    'docs/grigdesk/mobile/chat-layout-controls.md',
    'docs/grigdesk/mobile/contract-v1.md',
    'docs/grigdesk/mobile/design-parity.md',
    'docs/grigdesk/mobile/device-pitfalls.md',
    'docs/grigdesk/mobile/devlink.md',
    'docs/grigdesk/mobile/layout.md',
    'docs/grigdesk/mobile/limitations.md',
    'docs/grigdesk/mobile/native-security.md',
    'docs/grigdesk/mobile/operation-delivery.md',
    'docs/grigdesk/mobile/tablet-chat.md',
    'docs/grigdesk/server/mobile-startup-isolation.md',
  ]) {
    await assert.rejects(() => lstat(new URL(rel, root)), { code: 'ENOENT' }, rel);
  }

  const readme = await readFile(new URL('docs/grigdesk/mobile/README.md', root), 'utf8');
  const checks = await readFile(new URL('docs/grigdesk/mobile/checks.md', root), 'utf8');
  const relay = await readFile(new URL('docs/grigdesk/mobile/relay-deploy.md', root), 'utf8');
  const startup = await readFile(new URL('shared/node/darwinVerificationStartup.ts', root), 'utf8');

  assert.equal(readme.includes('Совместимость с прежним v1'), false);
  assert.equal(checks.includes('tools/mobile check'), true);
  assert.equal(checks.includes('e2e-local'), false);
  assert.match(relay, /^## Wire-протокол посредника$/mu);
  assert.equal(startup.includes('8144'), false);
});
