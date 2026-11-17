// Источник рассказа: задача Б24 по номеру и комментарий человека, без git.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBriefPrompt,
  buildScriptPrompt,
  SCRIPT_PROMPT_VERSION,
} from '../../server/src/lib/showcase/script/prompt.ts';
import {
  normalizeShowcaseSource,
  parseShowcaseStorySource,
  showcaseSourceEqual,
} from '../../shared/plugins/showcase/showcaseContracts.ts';

const SCREENS = [{
  id: 'overview',
  title: 'Обзор',
  path: '/',
  elements: [{ id: 'run' }],
}];

const CONTEXT = {
  taskTitle: 'Новый ролик',
  taskText: 'Задача 4920: показать фильтр.',
  note: 'Сделай упор на фильтре и результате.',
  screens: SCREENS,
  maxScenes: 5,
};

test('промпт брифа и сценария не содержит git-блоков', () => {
  const brief = buildBriefPrompt(CONTEXT);
  const script = buildScriptPrompt(CONTEXT, ['Показать фильтр']);

  for (const prompt of [brief, script]) {
    assert.doesNotMatch(prompt, /<commits>/u);
    assert.doesNotMatch(prompt, /<diff>/u);
    assert.doesNotMatch(prompt, /diff_truncated/u);
    assert.match(prompt, /<human_focus>/u);
    assert.match(prompt, /<task_text>/u);
  }

  assert.equal(SCRIPT_PROMPT_VERSION, 'showcase-script-11');
});

test('источник v2 нормализуется и сравнивается по задаче и комментарию', () => {
  const source = parseShowcaseStorySource({ taskId: ' 4920 ', note: '  про фильтр  ' });

  assert.deepEqual(normalizeShowcaseSource(source), { taskId: '4920', note: 'про фильтр' });
  assert.equal(
    showcaseSourceEqual(source, { taskId: '4920', note: 'про фильтр' }),
    true,
  );
  assert.equal(
    showcaseSourceEqual(source, { taskId: null, note: 'про фильтр' }),
    false,
  );
  assert.throws(() => normalizeShowcaseSource({ taskId: 'abc', note: '' }));
  assert.throws(() => normalizeShowcaseSource({ taskId: '4920', note: 'д'.repeat(2001) }));
});

