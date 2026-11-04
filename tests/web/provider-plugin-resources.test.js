import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProviderPluginUsage } from '../../shared/plugins/providerUsageResources.ts';
import { localizeUsageResource } from '../../web/src/features/providers/providerUsage.ts';

const resource = {
  key: 'forecast',
  label: 'Прогноз',
  summary: '0 % / 50 %',
  note: 'Оценка источника',
  translations: { en: { label: 'Forecast', note: 'Source estimate' } },
  controls: [{
    id: 'source',
    kind: 'link',
    label: 'Example',
    href: 'https://example.test/',
  }],
};

test('данные фонового плагина сохраняют атрибуцию, тексты и безопасную ссылку', () => {
  const [parsed] = parseProviderPluginUsage('feed', { resources: [resource] });
  const original = structuredClone(parsed);

  assert.equal(parsed.key, 'plugin:feed:forecast');
  assert.equal(parsed.kind, 'plugin');
  assert.equal(parsed.controls[0].scope, 'live');
  assert.equal(localizeUsageResource('custom-provider', parsed, 'en').label, 'Forecast');
  assert.equal(localizeUsageResource('codex', parsed, 'ru').summary, '0 % / 50 %');
  assert.equal(localizeUsageResource('codex', parsed, 'en').note, 'Source estimate');
  assert.deepEqual(parsed, original);
});

test('ссылки с credentials, исполняемые схемы и действия не становятся контролами', () => {
  for (const href of ['javascript:alert(1)', 'http://example.test/', 'https://user:secret@example.test/']) {
    assert.throws(() => parseProviderPluginUsage('feed', { resources: [{
      ...resource,
      controls: [{ ...resource.controls[0], href }],
    }] }));
  }

  assert.throws(() => parseProviderPluginUsage('feed', { resources: [{
    ...resource,
    controls: [{
      id: 'execute',
      kind: 'button',
      action: 'run-command',
    }],
  }] }));
});

test('пустой источник допустим; дубли, избыток строк и повреждённые переводы отвергаются', () => {
  assert.deepEqual(parseProviderPluginUsage('feed', { resources: [] }), []);
  assert.throws(() => parseProviderPluginUsage('feed', { resources: [resource, resource] }));
  assert.throws(() => parseProviderPluginUsage('feed', { resources: new Array(5).fill(resource) }));
  assert.throws(() => parseProviderPluginUsage('feed', { resources: [{
    ...resource,
    translations: { en: { note: { html: '<script>bad()</script>' } } },
  }] }));
  assert.throws(() => parseProviderPluginUsage('feed', { resources: [{
    ...resource,
    summary: 'x'.repeat(201),
  }] }));
});
