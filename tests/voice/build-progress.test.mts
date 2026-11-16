import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStepIds } from '../../cli/buildState.ts';
import { cliTranslator } from '../../cli/i18n.ts';

for (const [locale, dependencies, build] of [
  ['ru_RU.UTF-8', 'Voice: зависимости', 'Voice: сборка'],
  ['en_US.UTF-8', 'Voice: dependencies', 'Voice: build'],
]) {
  test(`voice-build-подписи-стадий-и-итог-${locale}`, () => {
    const { t } = cliTranslator({ LANG: locale });

    assert.equal(t('steps.voice.deps'), dependencies);
    assert.equal(t('steps.voice.build'), build);
    assert.match(t('allDescription'), /voice/u);
    assert.match(t('summaryAll'), /voice/u);
    assert.ok(buildStepIds('all').includes('voice.deps'));
    assert.ok(buildStepIds('all').includes('voice.build'));
  });
}
