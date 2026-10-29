import assert from 'node:assert/strict';
import test from 'node:test';
import { SYSTEM } from '../../server/src/lib/pluginsRegistry.ts';
import { settingsHarness } from './helpers/settings-harness.js';

// Реестр как в жизни: облачный исполнитель со «свежей» и «старой» моделями плюс локальный,
// у которого id модели с точкой, двоеточием и слэшем.
function providers() {
  return [
    {
      id: 'claude',
      name: 'Claude',
      available: true,
      capabilities: { scopedWorkspace: true, untrustedText: true },
      // Лестницы эффорта у моделей РАЗНЫЕ — на этом и держится проверка переноса.
      models: [
        {
          id: 'claude-opus-5',
          name: 'Opus 5',
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          id: 'claude-opus-4-8',
          name: 'Opus 4.8',
          extra: true,
          efforts: ['low', 'high'],
        },
      ],
    },
    {
      id: 'fake',
      name: 'Фейк',
      available: true,
      capabilities: { scopedWorkspace: false, untrustedText: true },
      // У локального эффорт бинарный: `xhigh` ему передать нельзя.
      models: [{
        id: 'hf.co/unsloth/qwen3.6:latest',
        name: 'qwen3.6 (hf)',
        efforts: ['low', 'high'],
      }],
    },
    {
      id: 'codex',
      name: 'GPT (Codex)',
      available: false,
      capabilities: { scopedWorkspace: true, untrustedText: false },
      models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }],
    },
  ];
}

const TRIAGE_SETTING = {
  key: 'triageModel',
  label: 'Модель для разбора',
  type: 'model',
  hint: 'Пока не выбрана, автоматические задачи не создаются ни в одном чате.',
  default: null,
};

const INBOX_PLUGIN = {
  id: 'inbox',
  system: true,
  name: 'Входящие',
  version: '1.0.0',
  description: 'Единая очередь обращений из подключённых каналов.',
  nav: {
    path: '/inbox',
    label: 'Входящие',
    icon: 'inbox',
  },
  settings: [TRIAGE_SETTING],
};
const CODE_PLUGIN = SYSTEM.find((plugin) => plugin.id === 'code');
const ANALYSIS_PLUGIN = {
  id: 'analysis',
  system: true,
  name: 'Триаж',
  version: '1.0.0',
  description: 'Оценка сложности и рисков по коду.',
  settings: [{
    ...TRIAGE_SETTING,
    label: 'Модель триажа',
    requiresCapability: 'scopedWorkspace',
  }],
};


function modelOption(provider, model) {
  return JSON.stringify({ provider, model });
}

/**
 * Прежние проверки modelRef выполняются на новой странице и общем Apply.
 * Транспорт возвращает полный принятый values без подмены Pinia и сессии.
 */
async function mountSettings(t, { value = null, plugin = INBOX_PLUGIN, prepareProviders = () => {} } = {}) {
  const saved = [];
  const state = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    entityId: plugin.id,
    /**
     * Каталог сохраняет capability и непрозрачные идентификаторы моделей.
     * Запись возвращает полную фактически принятую проекцию плагина.
     */
    prepare({ control, providers: store, plugins }) {
      store.providers = providers();
      prepareProviders(store);
      plugins.list = [{
        ...plugin,
        enabled: true,
        values: Object.fromEntries(plugin.settings.map((field, index) =>
          [field.key, index === 0 ? value : field.default ?? null])),
      }];
      control.handlers[`/api/plugins/${plugin.id}/settings`] = ({ body }) => {
        saved.push({ id: plugin.id, values: body.values });

        return new Response(JSON.stringify({
          ok: true,
          values: body.values,
          placements: [],
        }));
      };
    },
  });

  return {
    ...state,
    prov: state.providers,
    plugins: { plugin: state.plugins.byId(plugin.id) },
    saved,
    apply: () => state.settings.apply(),
    select: state.wrapper.find('[data-settings-field] select[aria-label]'),
  };
}

test('модели берутся из общего реестра исполнителей, группами', async (t) => {
  const { apply, wrapper, select } = await mountSettings(t);

  assert.ok(select.exists(), 'селекта модели нет — настройка нарисована полем ввода');
  assert.deepEqual(
    wrapper.findAll('[data-settings-field] optgroup').map((g) => g.attributes('label')),
    ['Claude', 'Фейк', 'GPT (Codex) — недоступен'],
    'исполнители обязаны стоять группами, а недоступный — с оговоркой',
  );
  // Старая версия («extra») в кратком списке не показывается — то же правило, что в чате.
  assert.deepEqual(
    wrapper.findAll('[data-settings-field] optgroup option').map((o) => o.text()),
    ['Opus 5', 'qwen3.6 (hf)', 'GPT-5.6'],
  );
  // Недоступность — итог последней проверки, а не приговор: CLI мог не ответить на опрос,
  // моргнуть сетью или разлогиниться на минуту. Оговорка в названии группы остаётся,
  // блокировки выбора нет — иначе один неудачный опрос решал бы за человека.
  assert.deepEqual(
    wrapper.findAll('[data-settings-field] optgroup option')
      .map((o) => o.attributes('disabled') !== undefined),
    [false, false, false],
  );
  // Подсказка манифеста должна доехать до экрана: она объясняет, почему без модели
  // автоматических задач не будет вовсе.
  assert.match(wrapper.text(), /автоматические задачи не создаются/);
});

test('карточка триажа предлагает только исполнителей с изолированным рабочим каталогом', async (t) => {
  const { apply, wrapper } = await mountSettings(t, { plugin: ANALYSIS_PLUGIN });

  assert.deepEqual(
    wrapper.findAll('[data-settings-field] optgroup').map((group) => group.attributes('label')),
    ['Claude', 'GPT (Codex) — недоступен'],
  );
});

test('системный Триаж сохраняет выбор GPT и его усилие вместо Claude', async (t) => {
  const plugin = SYSTEM.find((entry) => entry.id === 'analysis');
  const { apply, select, wrapper, saved, flushPromises } = await mountSettings(t, {
    plugin,
    value: {
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'max',
    },
    prepareProviders(store) {
      const provider = store.providers.find((entry) => entry.id === 'codex');

      provider.available = true;
      provider.models = [{
        id: 'gpt-triage',
        name: 'GPT для триажа',
        efforts: ['low', 'high'],
      }];
    },
  });

  await select.setValue(modelOption('codex', 'gpt-triage'));
  assert.equal(effortSelect(wrapper).element.value, '');
  await effortSelect(wrapper).setValue('high');
  await apply();
  await flushPromises();

  assert.deepEqual(saved.at(-1), {
    id: 'analysis',
    values: {
      triageModel: {
        provider: 'codex',
        model: 'gpt-triage',
        effort: 'high',
      },
      autoArbitrate: false,
    },
  });
});

for (const [provider, name, model] of [
  ['glm', 'GLM', '["zai","glm-5.3"]'],
  ['kimi', 'Kimi', 'kimi-code/k3'],
  ['deepseek', 'DeepSeek', '["deepseek-official","deepseek-v4-flash"]'],
]) {
  test(`системный Триаж предлагает и сохраняет ${name} с выбранным усилием`, async (t) => {
    const plugin = SYSTEM.find((entry) => entry.id === 'analysis');
    const { apply, select, wrapper, saved, flushPromises } = await mountSettings(t, {
      plugin,
      prepareProviders(store) {
        store.providers.push({
          id: provider,
          name,
          available: true,
          capabilities: { scopedWorkspace: true },
          models: [{
            id: model,
            name: `${name} для триажа`,
            efforts: ['low', 'high'],
          }],
        });
      },
    });

    assert.ok(select.findAll('option')
      .some((option) => option.attributes('value') === modelOption(provider, model)));
    await select.setValue(modelOption(provider, model));
    await effortSelect(wrapper).setValue('high');
    await apply();
    await flushPromises();

    assert.deepEqual(saved.at(-1).values.triageModel, {
      provider,
      model,
      effort: 'high',
    });
  });
}

test('«Презентации» предлагают Codex с безопасным вводом и сохраняют его модель и усилие', async (t) => {
  const plugin = { ...SYSTEM.find((entry) => entry.id === 'showcase'), setup: undefined };
  const { apply, wrapper, select, saved, flushPromises } = await mountSettings(t, {
    plugin,
    prepareProviders(prov) {
      const provider = prov.providers.find((entry) => entry.id === 'codex');
      provider.available = true;
      provider.capabilities.untrustedText = true;
      provider.models = [{
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        efforts: ['low', 'high'],
      }];
    },
  });

  assert.ok(select.findAll('option')
    .some((o) => o.attributes('value') === modelOption('codex', 'gpt-6-astra')));
  await select.setValue(modelOption('codex', 'gpt-6-astra'));
  await effortSelect(wrapper).setValue('high');
  await apply();
  await flushPromises();
  assert.deepEqual(saved.at(-1).values.scriptModel, {
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
  });
});

test('выбор сохраняется парой «исполнитель + модель», а id со слэшем не рвётся', async (t) => {
  const { apply, wrapper, plugins, saved, select, flushPromises } = await mountSettings(t);

  await select.setValue(modelOption('fake', 'hf.co/unsloth/qwen3.6:latest'));
  assert.equal(plugins.plugin.values.triageModel, null, 'несохранённый выбор остаётся в черновике');

  await apply();
  await flushPromises();
  assert.deepEqual(saved, [{
    id: 'inbox',
    values: { triageModel: { provider: 'fake', model: 'hf.co/unsloth/qwen3.6:latest' } },
  }], 'на сервер уезжает пара, а не склеенная строка');
});

test('модель недоступного исполнителя выбирается и сохраняется', async (t) => {
  // Причина недоступности бывает временной, а настройка живёт дольше: человек вправе
  // назначить модель заранее — сервер попробует запустить её и назовёт настоящий отказ.
  const { apply, wrapper, plugins, saved, select, flushPromises } = await mountSettings(t);

  await select.setValue(modelOption('codex', 'gpt-5.6'));
  assert.equal(plugins.plugin.values.triageModel, null);

  await apply();
  await flushPromises();
  assert.deepEqual(saved, [{ id: 'inbox', values: { triageModel: { provider: 'codex', model: 'gpt-5.6' } } }]);
});

test('сохранённый выбор показан выбранным', async (t) => {
  const { apply, select } = await mountSettings(t, { value: { provider: 'claude', model: 'claude-opus-5' } });

  assert.equal(select.element.value, modelOption('claude', 'claude-opus-5'));
});

test('«не выбрана» обнуляет настройку — автомат обязан замолчать', async (t) => {
  const { apply, wrapper, plugins, select, flushPromises } = await mountSettings(t, {
    value: { provider: 'claude', model: 'claude-opus-5' },
  });

  await select.setValue('');
  await apply();
  await flushPromises();
  assert.equal(plugins.plugin.values.triageModel, null, 'пустой выбор — это null, а не пустая пара');
});

test('пропавшая из реестра модель не выдаётся за «не выбрана»', async (t) => {
  // Сменили CLI, выключили демон — модели в каталоге больше нет. Выбор при этом остался
  // в настройках, и сервер ходит именно им: показать «не выбрана» значило бы соврать.
  const { apply, wrapper, select } = await mountSettings(t, {
    value: { provider: 'fake', model: 'сгинувшая:latest' },
  });

  assert.equal(select.element.value, modelOption('fake', 'сгинувшая:latest'));

  const lost = select.findAll('option').map((o) => o.text());

  assert.ok(lost.some((text) => text.includes('fake: сгинувшая:latest') && text.includes('нет в реестре')),
    'выбор должен остаться в списке с пометкой');
});

test('сохранённая несовместимая модель остаётся видимой до явной замены', async (t) => {
  const value = { provider: 'codex', model: 'gpt-5.6' };
  const { apply, wrapper, select } = await mountSettings(t, { value, plugin: CODE_PLUGIN });

  assert.equal(select.element.value, modelOption('codex', 'gpt-5.6'));
  assert.match(
    select.get('option[disabled]').text(),
    /GPT \(Codex\): GPT-5\.6.*не подходит для этой настройки/u,
  );
  assert.deepEqual(
    wrapper.findAll('[data-settings-field] optgroup').map((group) => group.attributes('label')),
    ['Claude', 'Фейк'],
  );
});

// ── Усилие ──────────────────────────────────────────────────────────────────
// Усилие — свойство ЗАПУСКА, а не модели: одна и та же модель разбирает встречу и
// быстро, и вдумчиво, а до правки выбора не было вовсе и ход всегда шёл на умолчании
// исполнителя. Лестницу объявляет сама модель, поэтому контрол не универсальный.

/** Селект усилия — второй `select.inp` карточки; первый всегда модель. */
function effortSelect(wrapper) {
  return wrapper.findAll('select').find((item) => item.attributes('aria-label') === 'Усилие');
}

test('карточка «Код» показывает модель сообщения и effort из серверного манифеста', async (t) => {
  const value = {
    provider: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
  };
  const { apply, wrapper, select } = await mountSettings(t, { value, plugin: CODE_PLUGIN });

  assert.equal(select.element.value, modelOption('claude', 'claude-opus-5'));
  assert.deepEqual(
    wrapper.findAll('[data-settings-field] optgroup').map((group) => group.attributes('label')),
    ['Claude', 'Фейк'],
    'небезопасный model transport нельзя предложить для чтения staged diff',
  );
  assert.match(wrapper.text(), /Модель для сообщения коммита/);
  assert.equal(effortSelect(wrapper).element.value, 'high');
});

test('усилия нет, пока не выбрана модель: выбирать уровень не у чего', async (t) => {
  const { apply, wrapper } = await mountSettings(t);

  assert.equal(Boolean(effortSelect(wrapper)), false);
});

test('у модели без своей лестницы контрола усилия нет вовсе', async (t) => {
  // Тот же принцип, что у слайдера в чате: пустой список эффортов — не «выбери низкий»,
  // а «этой модели уровень передать нечем».
  const { apply, wrapper } = await mountSettings(t, { value: { provider: 'codex', model: 'gpt-5.6' } });

  assert.equal(Boolean(effortSelect(wrapper)), false, 'у модели без efforts селект усилия рисовать нельзя');
});

test('усилие уезжает в ту же пару и сохраняется вместе с моделью', async (t) => {
  const { apply, wrapper, plugins, saved, flushPromises } = await mountSettings(
    t, { value: { provider: 'claude', model: 'claude-opus-5' } },
  );
  const effort = effortSelect(wrapper);

  assert.ok(effort, 'у Opus 5 лестница объявлена — селект обязан быть');
  assert.deepEqual(
    effort.findAll('option').map((o) => o.element.value),
    ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    'уровни берутся у модели, а не из общего списка',
  );
  assert.equal(effort.element.value, '', 'без выбора — умолчание исполнителя, а не выдуманный уровень');

  await effort.setValue('xhigh');
  assert.deepEqual(plugins.plugin.values.triageModel,
    { provider: 'claude', model: 'claude-opus-5' }, 'усилие применяется только после сохранения');

  await apply();
  await flushPromises();
  assert.deepEqual(saved.at(-1).values.triageModel,
    {
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'xhigh',
    },
    'на сервер уезжает тройка, а не отдельный ключ рядом');
});

test('пустое усилие СНИМАЕТ ключ, а не пишет пустую строку', async (t) => {
  const { apply, wrapper, plugins, flushPromises } = await mountSettings(
    t, { value: {
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'max',
    } },
  );

  await effortSelect(wrapper).setValue('');
  await apply();
  await flushPromises();
  assert.deepEqual(plugins.plugin.values.triageModel, { provider: 'claude', model: 'claude-opus-5' },
    'пустая строка в effort означала бы «уровень выбран и он пустой»');
});

test('смена модели не переносит уровень, которого у новой нет', async (t) => {
  // Ровно та грабля, из-за которой уровень вообще сверяется: `--effort xhigh` у модели
  // без такой возможности не игнорируется, а РОНЯЕТ запуск CLI.
  const { apply, wrapper, plugins, select, flushPromises } = await mountSettings(
    t, { value: {
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'xhigh',
    } },
  );

  await select.setValue(modelOption('fake', 'hf.co/unsloth/qwen3.6:latest'));
  await apply();
  await flushPromises();
  assert.deepEqual(plugins.plugin.values.triageModel,
    { provider: 'fake', model: 'hf.co/unsloth/qwen3.6:latest' },
    'у локальной модели эффорт бинарный — xhigh переносить некуда');

  // А совпавший уровень переносится: терять осознанный выбор человека тоже нельзя.
  await effortSelect(wrapper).setValue('high');
  await select.setValue(modelOption('claude', 'claude-opus-5'));
  await apply();
  await flushPromises();
  assert.equal(plugins.plugin.values.triageModel.effort, 'high');
});

test('уровень, пропавший у модели, показан пометкой, а не молча стёрт', async (t) => {
  // Обновили CLI, лестница модели изменилась. Сервер такой уровень снимет и пойдёт на
  // умолчании — человек обязан видеть, что его выбор больше не действует.
  const { apply, wrapper } = await mountSettings(
    t, {
      value: {
        provider: 'fake',
        model: 'hf.co/unsloth/qwen3.6:latest',
        effort: 'xhigh',
      },
    },
  );
  const effort = effortSelect(wrapper);

  assert.equal(effort.element.value, 'xhigh');
  assert.ok(effort.findAll('option').some((o) => o.text().includes('нет у этой модели')),
    'исчезнувший уровень обязан остаться в списке с оговоркой');
});
