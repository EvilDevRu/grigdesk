import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Речь: реальная новая форма, CUDA gate, opaque revision и серверные умолчания', async (t) => {
  const h = await settingsHarness(t, 'speech.advanced', 'SpeechPage');

  assert.match(h.wrapper.text(), /CUDA/);
  assert.equal(h.wrapper.findAll('option').find((option) => option.element.value === 'cuda')
    .attributes('disabled') !== undefined, true);
  h.settings.selectPage('speech.language');
  await h.flushPromises();

  const dictionary = h.wrapper.get('textarea');

  await dictionary.setValue('термины нового проекта');
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.deepEqual(h.writes()[0].body, { dictionary: 'термины нового проекта' });
  assert.equal(h.control.data.speech.revision, 'sha256:browser-fixture');
  h.settings.selectPage('speech.video');
  await h.flushPromises();
  assert.equal(h.wrapper.get('textarea').attributes('maxlength'), '600');
});
