import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installUiBrowser } from './helpers/ui-components.js';

const script = new URL('../../web/scripts/check-i18n.mjs', import.meta.url);
const base = {
  ru: {
    save: 'Сохранить',
    welcome: 'Привет, {name}',
    tasks: { 
      one: '{count} задача', 
      few: '{count} задачи', 
      many: '{count} задач', 
      other: '{count} задачи' 
    },
  },
  en: {
    save: 'Save',
    welcome: 'Hello, {name}',
    tasks: { one: '{count} task', other: '{count} tasks' },
  },
};

/**
 * Негативные примеры находятся в отдельном репозитории-фикстуре, не в рабочем scope.
 * Базовая фикстура обязана пройти до каждой намеренной порчи перевода или исходника.
 */
async function fixture(t) {
  const exists = await access(script).then(() => true, () => false);

  assert.equal(exists, true, 'К9: сторож каталога и новых надписей отсутствует');

  const root = await mkdtemp(path.join(os.tmpdir(), 'i18n-guard-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  /**
   * Писатель создаёт только относительные пути внутри временной фикстуры.
   * JSON и исходный текст проходят один и тот же интерфейс подготовки.
   */
  async function put(relative, value) {
    const file = path.join(root, relative);

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const locales = [
    { 
      id: 'ru', 
      name: 'Русский', 
      intlLocale: 'ru-RU' 
    },
    { 
      id: 'en', 
      name: 'English', 
      intlLocale: 'en-US' 
    },
  ];

  await put('web/scripts/i18n-scope.json', {
    version: 1,
    include: ['web/src/translated'],
    fragments: [],
    dynamicKeys: {},
    technicalTokens: [],
  });
  await put('shared/i18n/assets/locales/catalog.json', locales);

  for (const locale of ['ru', 'en']) {
    for (const area of ['core', 'settings', 'desktop', 'native']) {
      await put(`shared/i18n/assets/locales/${locale}/${area}.json`,
        area === 'core' ? base[locale] : { sample: locale === 'ru' ? 'Пример' : 'Example' });
    }
  }

  await put('web/src/translated/Example.vue', `<template><span>{{ t('core.save') }}</span></template>
<script setup lang="ts">import { t } from '../../ui';</script>`);

  const { checkI18n } = await import(script);
  const check = () => checkI18n({ repoRoot: root });

  assert.deepEqual(check().errors, [], 'Корректная фикстура не нарушает guard');

  return { 
    root, 
    put, 
    check, 
    locales 
  };
}

test('I18N-G01: missing key/EN/other/params дают адресную ошибку и CLI exit 1', async (t) => {
  for (const problem of ['missing-key', 'missing-en', 'missing-other', 'wrong-params']) {
    await t.test(problem, async (scenario) => {
      const f = await fixture(scenario);
      const en = structuredClone(base.en);

      if (problem === 'missing-key') {
        await f.put('web/src/translated/Example.vue',
          '<template><span>{{ t("core.absent") }}</span></template>');
      } else if (problem === 'missing-en') {
        delete en.save;
      } else if (problem === 'missing-other') {
        delete en.tasks.other;
      } else {
        en.welcome = 'Hello, {person}';
      }

      await f.put('shared/i18n/assets/locales/en/core.json', en);

      const errors = f.check().errors.join('\n');

      assert.match(errors, /(?:core\.(?:absent|save|tasks|welcome)|core\.json)/);

      const result = spawnSync(process.execPath, [script.pathname, '--repo-root', f.root], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout + result.stderr, /(?:Example\.vue|core\.json):\d+/);
    });
  }
});

test('I18N-G02: bare RU и EN во всех видимых sinks не проходят, технические строки разрешены', async (t) => {
  const sinks = [
    ['text', (text) => `<template><span>${text}</span></template>`],
    ['aria', (text) => `<template><span aria-label="${text}" /></template>`],
    ['label', (text) => `<template><UiButton label="${text}" /></template>`],
    ['placeholder', (text) => `<template><UiInput placeholder="${text}" /></template>`],
    ['loading-label', (text) => `<template><UiButton loading-label="${text}" /></template>`],
    ['metadata', (text) => `<script setup>const fields = [{ label: '${text}', id: 'stable' }];</script>`],
    ['message', (text) => `<script setup>showToast({ id: 'stable', title: '${text}' });</script>`],
    ['dialog', (text) => `<script setup>confirmDialog('${text}');</script>`],
  ];

  for (const [sink, source] of sinks) {
    for (const language of ['Новая надпись', 'New caption']) {
      await t.test(`${sink}: ${language}`, async (scenario) => {
        const f = await fixture(scenario);

        await f.put('web/src/translated/Added.vue', source(language));
        assert.match(f.check().errors.join('\n'), /web\/src\/translated\/Added\.vue:\d+/);
      });
    }
  }

  await t.test('ID, CSS, URL, comments, command и raw данные не являются подписью', async (scenario) => {
    const f = await fixture(scenario);

    await f.put('web/src/translated/Technical.vue', `<template>
  <span id="stable-id" class="primary" :data-value="raw">{{ raw }}</span>
</template>
<script setup lang="ts">
// Русский комментарий не является надписью.
const raw = defineProps<{ raw: string }>().raw;
const url = 'https://example.test';
const command = 'npm run build';
</script>`);
    assert.deepEqual(f.check().errors, []);
  });
});

test('I18N-G03: третий зарегистрированный каталог переводит тот же экран без ветвления по языку',
  async (t) => {
  const f = await fixture(t);
  const win = await installUiBrowser(t);
  const { createTranslator } = await import('../../shared/i18n/core.ts');
  const { h } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const locales = [...f.locales, { 
    id: 'fr', 
    name: 'Français', 
    intlLocale: 'fr-FR' 
  }];
  const messages = {
    ...base,
    fr: {
      save: 'Enregistrer',
      welcome: 'Bonjour, {name}',
      tasks: { one: '{count} tâche', other: '{count} tâches' },
    },
  };

  await f.put('shared/i18n/assets/locales/catalog.json', locales);

  for (const area of ['core', 'settings', 'desktop', 'native']) {
    await f.put(`shared/i18n/assets/locales/fr/${area}.json`,
      area === 'core' ? messages.fr : { sample: 'Exemple' });
  }

  assert.deepEqual(f.check().errors, []);

  const translator = createTranslator({ locales, messages });
  const screen = {
    props: ['locale'],
    render() {
      return h('button', translator.t(this.locale, 'save'));
    },
  };
  const wrapper = mount(screen, { attachTo: win.document.body, props: { locale: 'ru' } });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.text(), 'Сохранить');
  await wrapper.setProps({ locale: 'en' });
  assert.equal(wrapper.text(), 'Save');
  await wrapper.setProps({ locale: 'fr' });
  assert.equal(wrapper.text(), 'Enregistrer');
});
