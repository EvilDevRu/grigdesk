// Каталог Claude: окно контекста, свёртка варианта [1m] и гейт ступеней эффорта.
// Всё это раньше выводилось из ИМЕНИ модели, и потому врало: «нет суффикса [1m] —
// значит 200k» занижало окно всему текущему поколению (у Fable 5, Opus 5 и Sonnet 5
// миллион встроенный). Источник правды — реестр моделей внутри бинаря CLI.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claudeCatalog,
  claudeCatalogCacheKey,
} from '../../server/src/lib/executors/_claudeCatalog.ts';
import {
  mergeCatalog,
  mergeCatalogModel,
} from '../../server/src/lib/modelsRegistry.ts';
import claude from '../../server/src/lib/executors/claude.ts';

/** Запись реестра в том виде, в каком она лежит в бандле CLI. */
function entry(id, family, displayName, context, caps, out = 'default:64000,upper:128000') {
  return `{id:"${id}",family:"${family}",display_name:"${displayName}",knowledge_cutoff:"January 2026",`
    + `provider_ids:{first_party:"${id}"},context:{${context}},max_output_tokens:{${out}},`
    + `pricing:"tier_15_75",capabilities:[${caps.map((c) => `"${c}"`).join(',')}]}`;
}

/**
 * Синтетический «бинарь»: строки те же, что кокпит вылавливает из настоящего CLI.
 * Каталог кэшируется по realpath, поэтому каждому тесту — свой файл.
 */
async function fakeBin(t, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-catalog-'));
  const file = path.join(dir, 'claude');
  await fs.writeFile(file, `head\n${body}\ntail`);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return file;
}

const REGISTRY = [
  // Миллион ВСТРОЕННЫЙ — суффикса [1m] у записи нет вовсе.
  entry('claude-fable-5', 'fable', 'Fable 5', 'window:1e6,native_1m:!0,supports_1m_beta:!0',
    ['effort', 'max_effort', 'xhigh_effort', 'context_management']),
  entry('claude-opus-5', 'opus', 'Opus 5', 'window:1e6,native_1m:!0,supports_1m_suffix:!0',
    ['effort', 'max_effort', 'xhigh_effort', 'context_management']),
  // Окно 200k, миллион поднимается только суффиксом.
  entry('claude-opus-4-6', 'opus', 'Opus 4.6', 'window:200000,supports_1m_suffix:!0',
    ['effort', 'max_effort', 'context_management']),
  // Эффорт не принимает вовсе.
  entry('claude-haiku-4-5', 'haiku', 'Haiku 4.5', 'window:200000,supports_1m_suffix:!0',
    ['context_management'], 'default:32000,upper:64000'),
].join(',');

// Варианты с суффиксом лежат в бинаре отдельными строками — их ловит скан id.
const SUFFIXED = 'claude-opus-5[1m] claude-opus-4-6[1m]';

async function catalogOf(t) {
  const bin = await fakeBin(t, `${REGISTRY}\n${SUFFIXED}`);
  const list = await claudeCatalog({ claudeBin: bin });
  return new Map(list.map((m) => [m.id, m]));
}

test('окно контекста берётся из реестра бинаря, а не из суффикса в имени', async (t) => {
  const by = await catalogOf(t);
  // Главный случай: суффикса нет, а окно — миллион. Прежнее правило давало 200k,
  // и кольцо контекста краснело на 165k, то есть на 17% реальной заполненности.
  assert.equal(by.get('claude-fable-5').context, 1_000_000);
  assert.equal(by.get('claude-opus-5').context, 1_000_000);
  // Обратный случай: у модели окно действительно 200k — миллион ей не приписываем.
  assert.equal(by.get('claude-opus-4-6').context, 200_000);
  assert.equal(by.get('claude-haiku-4-5').context, 200_000);
  // А вот её вариант с суффиксом миллион даёт по-настоящему.
  assert.equal(by.get('claude-opus-4-6[1m]').context, 1_000_000);
});

test('подпись и потолок вывода приходят оттуда же', async (t) => {
  const by = await catalogOf(t);
  assert.equal(by.get('claude-fable-5').name, 'Fable 5');
  assert.equal(by.get('claude-opus-4-6[1m]').name, 'Opus 4.6 (1M)');
  assert.equal(by.get('claude-fable-5').maxOutput, 128_000);
  assert.equal(by.get('claude-haiku-4-5').maxOutput, 64_000);
});

test('[1m] у модели со встроенным миллионом становится exact modelRef alias, а не вторым пунктом', async (t) => {
  const by = await catalogOf(t);
  // Два пункта с одинаковым окном — это два одинаковых выбора в селекте.
  assert.equal(by.has('claude-opus-5[1m]'), false);
  // Но сохранённый в старом schema-2 чате exact id обязан резолвиться. Обычные aliases
  // для этого не подходят: `opus` динамически переезжает на новую версию.
  assert.deepEqual(by.get('claude-opus-5').modelRefAliases, ['claude-opus-5[1m]']);
  assert.deepEqual(by.get('claude-opus-5').aliases, ['opus']);
  // У Opus 4.6 суффикс меняет окно, поэтому остаётся отдельным пунктом.
  assert.equal(by.has('claude-opus-4-6[1m]'), true);
  // Пункт — форма базовой модели: краткий список держит её вместе с ней, а не как версию.
  assert.equal(by.get('claude-opus-4-6[1m]').variantOf, 'claude-opus-4-6');
  assert.equal(by.get('claude-opus-4-6').variantOf, undefined);
});

test('парсер ограничен одним объектом и не берёт отсутствующие поля у соседней модели', async (t) => {
  const partial = '{id:"claude-opus-5",family:"opus",display_name:"Opus {partial}",'
    + 'max_output_tokens:{default:32000,upper:64000}}';
  const healthy = entry('claude-fable-5', 'fable', 'Fable 5',
    'window:1e6,native_1m:!0', ['effort', 'xhigh_effort']);
  const bin = await fakeBin(t, `${partial},${healthy}`);
  const by = new Map((await claudeCatalog({ claudeBin: bin })).map((m) => [m.id, m]));

  const opus = by.get('claude-opus-5');
  assert.equal(opus.context, 200_000, 'окно соседнего Fable не протекло в Opus');
  assert.equal(opus.contextUnverified, true);
  assert.equal(opus.name, 'Opus {partial}', 'скобки в строке не обрывают объект');
  assert.equal(opus.maxOutput, 64_000, 'собственное поле записи всё ещё читается');
  assert.equal(opus.effortUnverified, true, 'capabilities соседней модели не протекли');
  assert.equal(opus.metadataUnverified, true);
  assert.deepEqual(claude.modelEfforts(opus, ['low', 'high', 'xhigh']), [],
    'непроверенный effort fail-closed, а не получает общий ladder');

  const fable = by.get('claude-fable-5');
  assert.equal(fable.context, 1_000_000);
  assert.equal(fable.contextUnverified, undefined, 'здоровая соседняя запись не наследует деградацию');
  assert.equal(fable.effortUnverified, undefined);
});

test('ступени эффорта гейтятся возможностями модели, а не общим списком CLI', async (t) => {
  const by = await catalogOf(t);
  const ladder = ['low', 'medium', 'high', 'xhigh', 'max'];
  // Порядок и имена ступеней остаются от живого `claude --help`.
  assert.deepEqual(claude.modelEfforts(by.get('claude-fable-5'), ladder), ladder);
  // У Opus 4.6 нет xhigh: `--effort xhigh` не игнорируется, а роняет запуск.
  assert.deepEqual(
    claude.modelEfforts(by.get('claude-opus-4-6'), ladder),
    ['low', 'medium', 'high', 'max'],
  );
  // Модель без `effort` вовсе — слайдера быть не должно.
  assert.deepEqual(claude.modelEfforts(by.get('claude-haiku-4-5'), ladder), []);
});

test('без данных о возможностях гейт молчит и остаётся общий ладдер', () => {
  const ladder = ['low', 'high'];
  assert.equal(claude.modelEfforts({ id: 'claude-unknown-9' }, ladder), null);
  assert.equal(claude.modelEfforts({ capabilities: ['effort'], effortGates: [] }, null), null);
});

test('сломанный разбор реестра не выдаёт заглушку за факт', async (t) => {
  // Бандл чужого CLI не контракт: реестр однажды переедет или сменит форму. Тогда
  // id по-прежнему находятся, а свойства — нет, и без признака кокпит молча вернул бы
  // всех к «окно 200k» — ровно к починенной ошибке, но уже без единого следа в интерфейсе.
  const bin = await fakeBin(t, 'claude-fable-5 claude-opus-5 claude-opus-4-6');
  const list = await claudeCatalog({ claudeBin: bin });
  assert.equal(list.length, 3, 'модели обязаны остаться — кокпит должен работать');
  assert.ok(list.every((m) => m.contextUnverified), 'окно не подтверждено — так и скажи');
});

test('повторная деградация сохраняет last-known metadata, но не скрывает unverified', () => {
  const stored = {
    id: 'claude-fable-5', name: 'Fable Five', context: 1_000_000, maxOutput: 128_000,
    capabilities: ['effort', 'xhigh_effort'], effortGates: ['xhigh', 'max'],
  };
  // Новый каталог не смог прочитать отдельные поля и предлагает заглушки.
  const fresh = {
    id: 'claude-fable-5', name: 'Fable 5', nameUnverified: true,
    context: 200_000, contextUnverified: true,
    maxOutput: null, maxOutputUnverified: true,
    metadataUnverified: true, effortUnverified: true,
  };
  const merged = mergeCatalogModel(fresh, stored);
  assert.equal(merged.context, 1_000_000, 'последнее проверенное значение обязано пережить поломку');
  assert.equal(merged.name, 'Fable Five');
  assert.equal(merged.maxOutput, 128_000);
  assert.deepEqual(merged.capabilities, ['effort', 'xhigh_effort']);
  assert.deepEqual(merged.effortGates, ['xhigh', 'max']);
  assert.equal(merged.contextUnverified, true, 'last-known окно не выдаётся за свежий факт');
  assert.equal(merged.metadataUnverified, true);
  assert.equal(merged.effortUnverified, true);
  assert.deepEqual(claude.modelEfforts(merged, ['low', 'high', 'xhigh']), [],
    'даже сохранённые capabilities не разрешают effort во время деградации');
  // Второй неудачный refresh получает уже помеченную persisted запись и тоже обязан
  // сохранить исходные факты, а не заменить их очередными fallback-ами.
  const twice = mergeCatalogModel(fresh, merged);
  assert.equal(twice.context, 1_000_000);
  assert.equal(twice.name, 'Fable Five');
  assert.equal(twice.maxOutput, 128_000);
  assert.deepEqual(twice.capabilities, stored.capabilities);
  assert.deepEqual(twice.effortGates, stored.effortGates);
  // А подтверждённое новым сканом окно нормально заменяет старое — в любую сторону.
  assert.equal(mergeCatalogModel({ id: 'x', context: 200_000 }, { id: 'x', context: 1_000_000 }).context, 200_000);
});

test('частичная запись с проверенным window обновляет окно и сохраняет только сломанные поля', async (t) => {
  const bin = await fakeBin(t,
    '{id:"claude-fable-5",family:"fable",context:{window:200000}}');
  const [fresh] = await claudeCatalog({ claudeBin: bin });
  assert.equal(fresh.context, 200_000);
  assert.equal(fresh.contextUnverified, undefined);
  assert.equal(fresh.nameUnverified, true);
  assert.equal(fresh.maxOutputUnverified, true);
  assert.equal(fresh.effortUnverified, true);

  const stored = {
    id: 'claude-fable-5', name: 'Fable verified', context: 1_000_000, maxOutput: 128_000,
    capabilities: ['effort', 'xhigh_effort'], effortGates: ['xhigh'],
  };
  const merged = mergeCatalogModel(fresh, stored);
  assert.equal(merged.context, 200_000, 'здоровое свежее window сильнее старого значения');
  assert.equal(merged.name, 'Fable verified');
  assert.equal(merged.maxOutput, 128_000);
  assert.deepEqual(merged.capabilities, stored.capabilities);
  assert.deepEqual(merged.effortGates, stored.effortGates);
  assert.deepEqual(claude.modelEfforts(merged, ['low', 'high', 'xhigh']), []);
});

test('disable-1M policy не даёт деградационному merge восстановить старый миллион', async (t) => {
  const prev = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = 'true';
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prev;
  });
  const bin = await fakeBin(t, 'claude-fable-5');
  const [fresh] = await claudeCatalog({ claudeBin: bin });
  assert.equal(fresh.context, 200_000);
  assert.equal(fresh.contextUnverified, undefined, 'policy cap известен независимо от registry');

  const merged = mergeCatalogModel(fresh, { id: 'claude-fable-5', context: 1_000_000 });
  assert.equal(merged.context, 200_000, 'авторитетный cap сильнее last-known native window');
  assert.equal(merged.metadataUnverified, true, 'остальные сломанные поля не маскируются');
});

test('нечитаемое число окна не превращается в правдоподобную чушь', async (t) => {
  // Разделители разрядов (`1_000_000`) регексп поймал бы как «1»: кокпит уверенно
  // показал бы окно в один токен вместо миллиона.
  const bin = await fakeBin(t, entry('claude-fable-5', 'fable', 'Fable 5',
    'window:1_000_000,native_1m:!0', ['effort']));
  const list = await claudeCatalog({ claudeBin: bin });
  // native_1m всё ещё читается, поэтому окно верное; но само число забраковано.
  assert.equal(list[0].context, 1_000_000);
  const bad = await fakeBin(t, entry('claude-sonnet-4-6', 'sonnet', 'Sonnet 4.6',
    'window:1000_000,supports_1m_suffix:!0', ['effort']));
  const list2 = await claudeCatalog({ claudeBin: bad });
  assert.equal(list2[0].context, 200_000, 'граница токена не даёт принять префикс 1000');
  assert.ok(list2[0].contextUnverified, 'и она обязана быть помечена непроверенной');
});

// Ловушка на смену формата бандла: гоняется по НАСТОЯЩЕМУ установленному CLI и падает
// в тот день, когда обновление CLI ломает разбор. Значений не проверяет — они меняются
// с каждым релизом Anthropic; проверяет, что таблица вообще читается.
test('реестр установленного CLI читается (пропускается, если CLI не установлен)', async (t) => {
  const list = await claudeCatalog({ claudeBin: 'claude' }).catch(() => null);
  if (!list?.length) return t.skip('claude CLI не установлен');
  const verified = list.filter((m) => !m.metadataUnverified);
  assert.ok(verified.length >= 5, `полностью прочитано только ${verified.length} записей реестра`);
  // В CLI есть compatibility id (`claude-opus-4` и аналоги) без объекта реестра.
  // Они допустимы только как явно помеченный fallback, а не повод считать весь scan здоровым.
  assert.ok(list.filter((m) => m.metadataUnverified).every((m) =>
    m.contextUnverified && m.nameUnverified && m.maxOutputUnverified && m.effortUnverified));
  const withCaps = list.filter((m) => Array.isArray(m.capabilities) && m.capabilities.length);
  assert.ok(withCaps.length >= 5, `возможности прочитаны только у ${withCaps.length} моделей`);
  assert.ok(verified.every((m) => m.context >= 1000), 'проверенное окно контекста разобрано в чушь');
});

test('CLAUDE_CODE_DISABLE_1M_CONTEXT убирает миллион, как и в самом CLI', async (t) => {
  const prev = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prev;
  });
  const by = await catalogOf(t);
  assert.equal(by.get('claude-fable-5').context, 200_000);
  assert.equal(by.has('claude-opus-4-6[1m]'), false, 'нельзя показывать (1M) с окном 200k');
  assert.ok(by.get('claude-opus-4-6').modelRefAliases.includes('claude-opus-4-6[1m]'));
  assert.ok([...by.values()].every((m) => !m.name.includes('(1M)')));
});

test('ложные bool-значения CLAUDE_CODE_DISABLE_1M_CONTEXT не выключают 1M', async (t) => {
  const prev = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prev;
  });
  for (const value of ['0', 'false', 'NO', 'off']) {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = value;
    const by = await catalogOf(t);
    assert.equal(by.get('claude-fable-5').context, 1_000_000, `${value} означает false`);
    assert.equal(by.has('claude-opus-4-6[1m]'), true);
    assert.equal(claudeCatalogCacheKey(), 'disable-1m:0');
  }
});

test('catalogCacheKey инвалидирует persisted каталог при смене env без смены CLI', async (t) => {
  const prev = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prev;
  });
  const file = {};
  let catalogCalls = 0;
  const ex = {
    catalogCacheKey: claudeCatalogCacheKey,
    probe: async () => ({ version: 'same-version' }),
    catalog: async () => {
      catalogCalls += 1;
      return [{ id: 'claude-opus-5', context: process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT ? 200_000 : 1_000_000 }];
    },
  };

  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  assert.equal(await mergeCatalog(file, 'claude', ex, {}), true);
  assert.equal(file.claude[0].context, 1_000_000);
  assert.equal(file._meta.claude.catalogCacheKey, 'disable-1m:0');
  assert.equal(await mergeCatalog(file, 'claude', ex, {}), false);
  assert.equal(catalogCalls, 1, 'неизменившийся fingerprint не пересканирует каталог');

  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
  assert.equal(await mergeCatalog(file, 'claude', ex, {}), true);
  assert.equal(catalogCalls, 2, 'env fingerprint сильнее неизменной версии CLI');
  assert.equal(file.claude[0].context, 200_000);
  assert.equal(file._meta.claude.catalogCacheKey, 'disable-1m:1');
});

test('merge хранит retired alias без exact id, но не перекрывает свежую отдельную модель', async () => {
  const retired = 'claude-opus-5[1m]';
  const file = {
    claude: [{
      id: 'claude-opus-5', context: 1_000_000,
      modelRefAliases: [retired],
    }],
  };
  let version = 'without-retired-string';
  let catalog = [{ id: 'claude-opus-5', context: 1_000_000 }];
  const ex = {
    probe: async () => ({ version }),
    catalog: async () => catalog,
  };

  await mergeCatalog(file, 'claude', ex, {});
  assert.deepEqual(file.claude[0].modelRefAliases, [retired],
    'исчезновение retired-строки из нового CLI не ломает старые schema-2 чаты');

  version = 'degraded-with-exact';
  catalog = [
    { id: 'claude-opus-5', context: 200_000, contextUnverified: true, metadataUnverified: true },
    { id: retired, context: 1_000_000, metadataUnverified: true },
  ];

  await mergeCatalog(file, 'claude', ex, {});
  assert.deepEqual(file.claude.map((m) => m.id), ['claude-opus-5', retired],
    'при неизвестной семантике сохраняется свежий exact id, а не stale-канонизация');
  assert.equal(file.claude[0].modelRefAliases, undefined);
  assert.equal(file.claude[0].contextUnverified, true);

  version = 'healthy-separate';
  catalog = [
    { id: 'claude-opus-5', context: 200_000 },
    { id: retired, context: 1_000_000 },
  ];
  await mergeCatalog(file, 'claude', ex, {});
  assert.deepEqual(file.claude.map((m) => m.id), ['claude-opus-5', retired]);
  assert.equal(file.claude[0].modelRefAliases, undefined,
    'здоровый отдельный exact id сильнее прежней retired-эквивалентности');
});

test('binary cache инвалидируется при замене файла по тому же realpath', async (t) => {
  const bin = await fakeBin(t, entry('claude-haiku-4-5', 'haiku', 'Haiku 4.5',
    'window:200000', ['effort']));
  const first = await claudeCatalog({ claudeBin: bin });
  assert.equal(first.some((m) => m.id === 'claude-haiku-4-5'), true);

  await fs.writeFile(bin, `head\n${entry('claude-fable-5', 'fable', 'Fable 5 changed',
    'window:1e6,native_1m:!0', ['effort', 'xhigh_effort'])}\ntail changed`);
  const second = await claudeCatalog({ claudeBin: bin });
  assert.equal(second.some((m) => m.id === 'claude-haiku-4-5'), false);
  assert.equal(second.find((m) => m.id === 'claude-fable-5')?.name, 'Fable 5 changed');
});
