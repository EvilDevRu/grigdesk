import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadTriageProfile, parseRulesFiles } from '../../server/src/lib/analysis/profile.ts';
import { buildTriagePrompt } from '../../server/src/lib/analysis/prompt.ts';

// Триаж очерчивал объём по буквальным шагам тикета: соседние места с той же бедой и режимы,
// которые меняют результат, не искал никто, а свой же вариант ответа на открытый вопрос
// он вписывал в критерии «например» — и конвейер сверял работу с догадкой дословно.

const EMPTY_PROFILE = {
  ctx: '',
  markers: '',
  repos: [],
  rules: [],
};

/**
 * Промпт триажа с минимальной постановкой, пробелы и переносы схлопнуты: тестам важны
 * только блоки правил и шаг сверки с продуктом, а не то, где промпт переносит строку.
 */
function render(profile, sources = []) {
  const prompt = buildTriagePrompt({
    task: 42,
    title: 'Имя файла выгрузки',
    description: 'В имени файла нет даты',
    comments: [],
    clarifications: '',
    discussion: '',
    profile,
    sources,
    jsonPath: '/tmp/t42.analysis.json',
    notePath: '/tmp/t42.md',
  });

  return prompt.replace(/\s+/gu, ' ');
}

test('файлы правил профиля: пары ключ/путь, без абсолютных путей и выхода из корня', () => {
  assert.deepEqual(parseRulesFiles(''), []);
  assert.deepEqual(parseRulesFiles(' be:.claude/rules.md\nfe:docs/ui.md '), [
    {
      key: 'be',
      path: '.claude/rules.md',
    },
    {
      key: 'fe',
      path: 'docs/ui.md',
    },
  ]);
  assert.deepEqual(parseRulesFiles('be:/etc/passwd be:../x.md :a.md be: fe:docs/../../y.md'), []);
});

test('загрузчик профиля читает PROFILE_TRIAGE_RULES, профиль без него — пустой список', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-profile-rules-'));

  t.after(() =>
    rm(root, {
      recursive: true,
      force: true,
    }),
  );

  const profiles = {
    rules: 'PROFILE_TRIAGE_RULES="be:.claude/knowledge/product-rules.md"',
    plain: 'PROFILE_TRIAGE_REPOS="be:/tmp/x"',
  };
  const loaded = {};

  for (const [name, body] of Object.entries(profiles)) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'profile.sh'), `${body}\n`);
    loaded[name] = (
      await loadTriageProfile(
        {
          factoryHome: root,
          profilesDir: root,
        },
        name,
      )
    ).rules;
  }

  assert.deepEqual(loaded, {
    rules: [
      {
        key: 'be',
        path: '.claude/knowledge/product-rules.md',
      },
    ],
    plain: [],
  });
});

test('правила продукта читаются в снимке кода захода, а не в рабочей копии', () => {
  const prompt = render(
    {
      ...EMPTY_PROFILE,
      rules: [
        {
          key: 'be',
          path: '.claude/knowledge/product-rules.md',
        },
      ],
    },
    [
      {
        key: 'be',
        dir: '/snap/be/',
        ref: 'origin/master',
        sha: 'abcdef0123456789',
      },
    ],
  );

  assert.match(prompt, /\[Правила продукта\]/u);
  assert.ok(prompt.includes('- be: /snap/be/.claude/knowledge/product-rules.md'), prompt);
  assert.match(prompt, /Правило сильнее соседей и твоего вкуса/u);
  assert.match(prompt, /Правила продукта \(блок выше\)/u);
});

test('без правил блока нет, но сверка с соседями, режимами и историей остаётся', () => {
  const prompt = render(EMPTY_PROFILE);

  assert.doesNotMatch(prompt, /\[Правила продукта\]/u);
  assert.match(prompt, /Сверь задачу с тем, как принято в продукте/u);
  assert.match(prompt, /Соседи — 2–5 мест продукта, где делается то же самое/u);
  assert.match(prompt, /Режимы — что меняет этот результат/u);
  assert.match(prompt, /найди его в истории через repo_history/u);
  assert.match(prompt, /Сосед с той же бедой — вопрос «распространить на …\?» с рекомендацией/u);
  assert.match(prompt, /## Как принято у нас — правила, соседи, режимы, прежнее поведение/u);
});

test('свой вариант ответа на открытый вопрос триаж в критерии не подставляет', () => {
  const prompt = render(EMPTY_PROFILE);

  assert.match(prompt, /в do\[\] не подставляй ни прямо, ни «например»/u);
  assert.match(
    prompt,
    /Пример в do\[\] — только из постановки, ответа человека или правила продукта/u,
  );
});
