import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PluginSourceRegistry,
  createDefaultPluginSources,
} from '../../server/src/lib/packageInstall/sources.ts';
import { GitPluginSource } from '../../server/src/lib/packageInstall/gitSource.ts';

test('SR1: пустой реестр и повтор kind отвергаются', () => {
  assert.throws(() => new PluginSourceRegistry([]), TypeError);
  assert.throws(() => new PluginSourceRegistry([new GitPluginSource(), new GitPluginSource()]), TypeError);
});

test('SR2: неизвестный kind имеет контрактный отказ', () => {
  const registry = new PluginSourceRegistry([new GitPluginSource()]);

  assert.throws(() => registry.get('missing'), { code: 'source_kind_unknown' });
});

/**
 * Fixture mirror представляет альтернативную стратегию, не ветку caller по вендору.
 * Остальные методы ниже подключаются к простому contract caller отдельно.
 */
function mirrorSource(calls = []) {
  return {
    kind: 'mirror',
    normalizeUrl(raw) {
      if (typeof raw !== 'string' || !raw.startsWith('mirror://')) {
        throw new Error('Адрес не относится к mirror');
      }

      return raw;
    },
    async listVersions() {
      return [];
    },
    async fetch() {
      calls.push('fetch');
    },
    async changes() {
      calls.push('changes');

      return null;
    },
    async inspectInstalled() {
      calls.push('inspect');

      return { sha: null, modified: false };
    },
  };
}

test('SR3: specialized source стоит перед Git, неподдержанный URL возвращает последний отказ', () => {
  const mirror = mirrorSource();
  const git = new GitPluginSource();
  const registry = new PluginSourceRegistry([mirror, git]);

  assert.equal(registry.forUrl('mirror://demo').source.kind, 'mirror');
  assert.equal(registry.forUrl('https://git.example.invalid/team/demo.git').source.kind, 'git');
  assert.throws(() => registry.forUrl('ext::fixture-secret'), { code: 'source_url_invalid' });
});

test('SR4: default registry содержит настоящий GitPluginSource', () => {
  let registry;

  assert.doesNotThrow(() => {
    registry = createDefaultPluginSources();
  });
  assert.ok(registry.get('git') instanceof GitPluginSource);
});

test('SR5: contract caller использует второй kind для fetch/changes/inspect', async () => {
  const calls = [];
  const registry = new PluginSourceRegistry([mirrorSource(calls), new GitPluginSource()]);
  const selected = registry.forUrl('mirror://demo');
  const source = registry.get(selected.source.kind);

  assert.equal(source.kind, 'mirror');

  await source.fetch({ url: selected.url });
  await source.changes('directory', 'from', 'to');
  await source.inspectInstalled('directory', {});
  assert.deepEqual(calls, ['fetch', 'changes', 'inspect']);
  assert.equal(registry.get('git').kind === source.kind, false);
});
