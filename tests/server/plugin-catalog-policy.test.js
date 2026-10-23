import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sourceMembership, compatibleVersions, detailMatchesIndex, catalogAction,
} from '../../shared/plugins/pluginCatalogPolicy.ts';
import { catalogFixture } from '../helpers/pluginCatalog.js';

test('CAT-P1: id вместе с HTTPS/SSH source, offline и manual не получают доверие', () => {
  const { index, entry } = catalogFixture();

  for (const url of [entry.source.url, 'https://github.com/EXAMPLE/demo/',
    'git@github.com:example/demo.git', 'ssh://git@github.com/example/demo.git']) {
    assert.equal(sourceMembership(index, 'fresh', 'demo', { kind: 'git', url }), 'community');
  }

  for (const url of ['https://github.com/other/demo.git', 'https://github.com.evil.invalid/example/demo',
    'https://user@github.com/example/demo.git', 'file:///example/demo']) {
    assert.equal(sourceMembership(index, 'fresh', 'demo', { kind: 'git', url }), 'external');
  }

  assert.equal(sourceMembership(index, 'fresh', 'other', entry.source), 'external');
  assert.equal(sourceMembership(index, 'stale', 'demo', entry.source), 'unverified');
  assert.equal(sourceMembership(null, 'unavailable', 'demo', entry.source), 'unverified');
  assert.equal(sourceMembership(index, 'fresh', 'demo', null), 'manual');
});

test('CAT-P2: максимум совместимых, отсутствие минимума, архив и конфликт источника', () => {
  const { detail, entry, version } = catalogFixture();

  detail.plugin.versions = [
    {
      ...version,
      version: '2.0.0',
      tag: 'v2.0.0',
      minGrigDeskVersion: '2.0.0'
    },
    {
      ...version,
      version: '1.10.0',
      tag: 'v1.10.0',
      minGrigDeskVersion: null
    },
    {
      ...version,
      version: '1.9.0',
      tag: 'v1.9.0'
    },
  ];
  assert.deepEqual(compatibleVersions(detail.plugin, '1.0.0').map((item) => item.version),
    ['1.10.0', '1.9.0']);
  assert.equal(catalogAction(detail.plugin, '1.0.0', null).target.version, '1.10.0');

  const installed = {
    id: 'demo',
    version: 'local',
    install: {
      source: entry.source,
      sha: 'b'.repeat(40),
      version: '1.0.0'
    },
  };

  assert.equal(catalogAction(detail.plugin, '1.0.0', installed).action, 'update');
  installed.install.source = { kind: 'git', url: 'https://github.com/other/demo.git' };
  assert.equal(catalogAction(detail.plugin, '1.0.0', installed).action, 'conflict');
  installed.system = true;
  assert.equal(catalogAction(detail.plugin, '1.0.0', installed).action, 'conflict');
  detail.plugin.archived = true;
  assert.equal(catalogAction(detail.plugin, '1.0.0', null).reason, 'archived');
});

test('CAT-P3: detail обязан совпасть со snapshot и latest индекса', () => {
  const { index, detail } = catalogFixture();

  assert.equal(detailMatchesIndex(index, detail, 'demo'), true);
  detail.generatedAt = '2026-10-21T10:00:00.000Z';
  assert.equal(detailMatchesIndex(index, detail, 'demo'), false);
  detail.generatedAt = index.generatedAt;
  detail.plugin.versions[0].sha = 'b'.repeat(40);
  assert.equal(detailMatchesIndex(index, detail, 'demo'), false);
});
