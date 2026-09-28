import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from '../../web/node_modules/acorn/dist/acorn.mjs';

const testsDir = path.dirname(new URL(import.meta.url).pathname);
const equalityAssertions = new Set([
  'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'notEqual', 'notStrictEqual',
]);
// `notEqual` падает, только когда стороны равны: против примитива узла в ошибке не окажется.
const inequalityAssertions = new Set(['notEqual', 'notStrictEqual']);
const domMemberNames = new Set([
  '$el', 'element', 'firstElementChild', 'lastElementChild', 'nextElementSibling',
  'parentElement', 'parentNode', 'previousElementSibling',
]);
const documentMemberNames = new Set(['activeElement', 'body', 'documentElement']);
const domQueryNames = new Set([
  'closest', 'getElementById', 'getElementsByClassName', 'getElementsByTagName',
  'querySelector', 'querySelectorAll',
]);
// Поиск @vue/test-utils: обёртка держит element, и упавший assert печатает его вместе с окном.
const wrapperQueryNames = new Set(['find', 'findAll']);
const componentQueryNames = new Set(['findAllComponents', 'findComponent', 'getComponent']);
const mountNames = new Set(['mount', 'shallowMount']);
// Выбор из набора узлов или обёрток сохраняет опасность: `[...nodes].find(fn)`, `rows.at(0)`.
const pickNames = new Set(['at', 'filter', 'find', 'findLast', 'slice']);
const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression']);
const declarationCache = new WeakMap();

// Упавший assert печатает и узел happy-dom, и обёртку test-utils вместе со всем окном:
// процесс растёт больше чем на гигабайт в секунду. Каждый пример — отдельный файл.
const dangerous = {
  'узел в переменной': `
    const el = document.querySelector('.x');
    assert.equal(el, null);
  `,
  'помощник ищет узел в наборе': `
    function buttonByText(browser, text) {
      return [...browser.document.querySelectorAll('button')].find((button) => button.textContent === text);
    }
    assert.equal(buttonByText(browser, 'Да'), undefined);
  `,
  'помощник отдаёт обёртку через переменную': `
    function button(wrapper, label) {
      const found = wrapper.findAll('button').find((entry) => entry.text() === label);
      return found;
    }
    assert.equal(button(wrapper, 'Да'), undefined);
  `,
  'помощник зовёт помощника': `
    const rowOf = (wrapper) => wrapper.findAll('tr').at(0);
    function cellOf(wrapper) {
      return rowOf(wrapper);
    }
    assert.equal(cellOf(wrapper), undefined);
  `,
  'асинхронный помощник': `
    async function openTip(wrapper) {
      return wrapper.find('.tip');
    }
    assert.equal(await openTip(wrapper), null);
  `,
  'обёртка test-utils напрямую': `
    assert.equal(wrapper.find('.x'), undefined);
  `,
  'элемент набора обёрток по индексу': `
    assert.deepEqual(wrapper.findAll('li')[0], {});
  `,
  'результат mount': `
    const wrapper = mount(Component);
    assert.equal(wrapper, null);
  `,
  'соседний узел, как раньше': `
    assert.equal(tip.parentElement, document.body);
  `,
  'notEqual двух узлов': `
    assert.notEqual(tip.parentElement, document.body);
  `,
};

const safe = {
  'Boolean от помощника': `
    function buttonByText(browser, text) {
      return [...browser.document.querySelectorAll('button')].find((button) => button.textContent === text);
    }
    assert.equal(Boolean(buttonByText(browser, 'Да')), false);
  `,
  'атрибут и текст обёртки': `
    function button(wrapper, label) {
      return wrapper.findAll('button').find((entry) => entry.text() === label);
    }
    assert.equal(button(wrapper, 'Да').attributes('disabled'), undefined);
    assert.equal(wrapper.find('.x').text(), 'x');
  `,
  'сравнение с null через ===': `
    assert.equal(document.querySelector('.x') === null, true);
  `,
  'поиск в обычном массиве': `
    const calls = [];
    const rows = listRows();
    assert.deepEqual(calls.find((call) => call[0] === 'post'), ['post']);
    assert.equal(rows.find((row) => row.path === 'a').file, 1);
  `,
  'Map.get со строковым ключом': `
    const store = new Map();
    assert.equal(store.get('key'), 1);
  `,
  'notEqual против undefined падает только на undefined': `
    const button = (wrapper) => wrapper.findAll('button').find((entry) => entry.text() === 'Да');
    assert.notEqual(button(wrapper), undefined);
  `,
  'текст узла из переменной': `
    const el = document.querySelector('.x');
    assert.equal(el.textContent, 'x');
  `,
  'внутренняя переменная затеняет узел': `
    const el = document.querySelector('.x');
    test('тень', () => {
      const el = 'текст';
      assert.equal(el, 'текст');
    });
  `,
};

/**
 * Имя свойства в `a.b` и `a['b']`, номер — в `a[0]`; для вычисляемого имени — null.
 * По имени детектор узнаёт запросы к DOM и поиск test-utils.
 */
function memberName(node) {
  if (!node?.computed && node?.property?.type === 'Identifier') return node.property.name;
  if (node?.computed && node?.property?.type === 'Literal') return node.property.value;
  return null;
}

function selectorArgument(node) {
  return node?.type === 'TemplateLiteral'
    || node?.type === 'ObjectExpression'
    || (node?.type === 'Literal' && typeof node.value === 'string');
}

function primitiveValue(node) {
  return (node?.type === 'Literal' && !node.regex)
    || node?.type === 'TemplateLiteral'
    || (node?.type === 'Identifier' && node.name === 'undefined');
}

function equalityAssert(node) {
  return node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.object?.type === 'Identifier'
    && node.callee.object.name === 'assert'
    && equalityAssertions.has(memberName(node.callee));
}

/**
 * Обходит дерево и отдаёт каждому узлу цепочку областей от ближайшей функции до модуля.
 * `skip` отрезает поддеревья: так тело функции читается без вложенных функций.
 */
function walk(node, visit, { chain = [], skip = () => false } = {}) {
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit, { chain, skip }));

    return;
  }
  if (!node || typeof node.type !== 'string' || skip(node)) {
    return;
  }

  const inner = functionTypes.has(node.type) ? [declarationsOf(node), ...chain] : chain;

  visit(node, inner);

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc' && value && typeof value === 'object') {
      walk(value, visit, { chain: inner, skip });
    }
  }
}

/**
 * Объявления одной области: параметры функции и переменные её тела без вложенных функций.
 * Параметр записан без значения — так он затеняет внешнее имя, но опасным не считается.
 */
function declarationsOf(owner) {
  if (declarationCache.has(owner)) {
    return declarationCache.get(owner);
  }

  const names = new Map();

  for (const param of owner.params || []) {
    if (param.type === 'Identifier') {
      names.set(param.name, null);
    }
  }

  walk(owner.body, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      names.set(node.id.name, node.init);
    }
  }, { skip: (node) => functionTypes.has(node.type) });
  declarationCache.set(owner, names);

  return names;
}

/**
 * Возвращаемые выражения функции: тело стрелки или аргументы её собственных `return`.
 * `return` вложенных функций не считаются — они возвращают из другого места.
 */
function returnedValues(fn) {
  if (fn.body?.type !== 'BlockStatement') {
    return [fn.body];
  }

  const values = [];

  walk(fn.body, (node) => {
    if (node.type === 'ReturnStatement' && node.argument) {
      values.push(node.argument);
    }
  }, { skip: (node) => functionTypes.has(node.type) });

  return values;
}

/**
 * Область проверки выражения: объявления от ближайшей функции до модуля, помощники файла и
 * значения, которые разрешаются сейчас, — защита от круга вида `a = b; b = a`.
 */
function createScope(chain, helpers, resolving = new Set()) {
  return {
    helpers,

    /**
     * Находит ближайшее объявление имени и проверяет его значение в области объявления.
     * Параметр и переменная без значения опасными не считаются.
     */
    domName(name) {
      const level = chain.findIndex((names) => names.has(name));
      const init = level === -1 ? null : chain[level].get(name);

      if (!init || resolving.has(init)) {
        return false;
      }

      resolving.add(init);

      try {
        return domValue(init, createScope(chain.slice(level), helpers, resolving));
      } finally {
        resolving.delete(init);
      }
    },
  };
}

/**
 * Может ли выражение оказаться узлом happy-dom, обёрткой test-utils или их набором. Узнаёт
 * прямые запросы, выбор из набора, помощника файла, результат `mount` и переменную с узлом.
 */
function domValue(node, scope) {
  switch (node?.type) {
    case 'ChainExpression':
      return domValue(node.expression, scope);
    case 'AwaitExpression':
      return domValue(node.argument, scope);
    case 'LogicalExpression':
      return domValue(node.left, scope) || domValue(node.right, scope);
    case 'ConditionalExpression':
      return domValue(node.consequent, scope) || domValue(node.alternate, scope);
    case 'ArrayExpression':
      return node.elements.some((item) => (
        domValue(item?.type === 'SpreadElement' ? item.argument : item, scope)
      ));
    case 'Identifier':
      return scope.domName(node.name);
    case 'MemberExpression':
      return domMember(node, scope);
    case 'CallExpression':
      return domCall(node, scope);
    default:
      return false;
  }
}

/**
 * Свойство, дающее узел: соседи и родитель, `document.body`, `wrapper.element` или элемент
 * набора по индексу — `querySelectorAll('li')[0]`, `wrapper.findAll('li')[1]`.
 */
function domMember(node, scope) {
  const name = memberName(node);
  const owner = node.object?.type === 'Identifier' ? node.object.name : memberName(node.object);

  if (domMemberNames.has(name) || (documentMemberNames.has(name) && owner === 'document')) {
    return true;
  }

  return node.computed && typeof name !== 'string' && domValue(node.object, scope);
}

/**
 * Вызов, возвращающий узел или обёртку: запрос к DOM, поиск test-utils по селектору, выбор из
 * такого набора, `Array.from`, `mount` и помощник файла. `find(fn)` у обычного массива безопасен.
 */
function domCall(node, scope) {
  const callee = node.callee?.type === 'ChainExpression' ? node.callee.expression : node.callee;

  if (callee?.type === 'Identifier') {
    return mountNames.has(callee.name) || scope.helpers.has(callee.name);
  }
  if (callee?.type !== 'MemberExpression') {
    return false;
  }

  const name = memberName(callee);

  if (domQueryNames.has(name) || componentQueryNames.has(name)) {
    return true;
  }
  if (wrapperQueryNames.has(name) && selectorArgument(node.arguments[0])) {
    return true;
  }
  if (name === 'from' && callee.object?.type === 'Identifier' && callee.object.name === 'Array') {
    return domValue(node.arguments[0], scope);
  }

  return pickNames.has(name) && domValue(callee.object, scope);
}

/**
 * Имена функций файла, которые возвращают узел или обёртку: вызов `buttonByText(...)` опасен
 * так же, как `querySelector(...)`. Проход повторяется, пока находятся новые помощники, —
 * помощник может звать другого помощника.
 */
function domHelperNames(tree) {
  const functions = [];
  const helpers = new Set();

  walk(tree, (node, chain) => {
    if (node.type === 'FunctionDeclaration' && node.id) {
      functions.push({
        name: node.id.name,
        fn: node,
        chain,
      });
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && functionTypes.has(node.init?.type)) {
      functions.push({
        name: node.id.name,
        fn: node.init,
        chain: [declarationsOf(node.init), ...chain],
      });
    }
  }, { chain: [declarationsOf(tree)] });

  let grown = true;

  while (grown) {
    grown = false;

    for (const { name, fn, chain } of functions) {
      const scope = createScope(chain, helpers);

      if (!helpers.has(name) && returnedValues(fn).some((value) => domValue(value, scope))) {
        helpers.add(name);
        grown = true;
      }
    }
  }

  return helpers;
}

/**
 * Находит equality-assert, которому передан узел happy-dom или обёртка test-utils: напрямую,
 * через помощника файла или через переменную. Возвращает места `file:line`.
 */
function domAssertionFindings(source, file) {
  const tree = parse(source, { ecmaVersion: 'latest', locations: true, sourceType: 'module' });
  const helpers = domHelperNames(tree);
  const findings = [];

  walk(tree, (node, chain) => {
    if (!equalityAssert(node)) {
      return;
    }

    const [actual, expected] = node.arguments;
    const scope = createScope(chain, helpers);

    if (inequalityAssertions.has(memberName(node.callee))
      && (primitiveValue(actual) || primitiveValue(expected))) {
      return;
    }
    if (domValue(actual, scope) || domValue(expected, scope)) {
      findings.push(`${file}:${node.loc.start.line}`);
    }
  }, { chain: [declarationsOf(tree)] });

  return findings;
}

test('детектор узнаёт узлы и обёртки за помощниками, переменными и наборами', () => {
  const missed = Object.entries(dangerous)
    .filter(([, source]) => domAssertionFindings(source, 'case.js').length !== 1)
    .map(([name]) => name);

  assert.deepEqual(missed, []);
});

test('детектор не трогает скалярные сравнения', () => {
  const flagged = Object.entries(safe)
    .filter(([, source]) => domAssertionFindings(source, 'case.js').length > 0)
    .map(([name]) => name);

  assert.deepEqual(flagged, []);
});

test('DOM-узлы не передаются напрямую в equality-assert', async () => {
  const files = (await readdir(testsDir)).filter((file) => file.endsWith('.test.js')).sort();
  const findings = [];

  for (const file of files) {
    findings.push(...domAssertionFindings(await readFile(path.join(testsDir, file), 'utf8'), file));
  }

  assert.deepEqual(findings, [], 'сравнивай Boolean/===, атрибут, текст или другое скалярное значение');
});
